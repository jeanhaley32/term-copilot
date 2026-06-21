// term-copilot bridge — the spine.
//
// Listens on a Unix domain socket. Clients (the Hyper plugin, or the dummy
// test client) connect and speak NDJSON (see protocol.js):
//   - they stream terminal output as { type: "term_data", data } frames
//   - they send questions as { type: "chat_msg", text } frames
// The bridge keeps a rolling buffer of recent terminal output and, on each
// chat_msg, asks the local Claude Code instance and streams the reply back as
// { type: "chat_stream", text } frames followed by { type: "chat_done" }.
//
// Terminal output goes to the BRIDGE, never directly to the model. Claude is
// only invoked on demand (a chat_msg), with the recent buffer as context.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { encode, createDecoder } from "./protocol.js";
import { RollingBuffer } from "./buffer.js";
import { ask } from "./claude.js";
import { RateGuard, CircuitOpenError } from "./rateguard.js";

const SOCK = process.env.TERM_COPILOT_SOCK || path.join(os.homedir(), ".term-copilot.sock");

// One shared buffer across all connected clients (a single terminal session for
// now; M3 can key buffers per session id).
const buffer = new RollingBuffer(16000);

// The terminal's current working directory, reported by the client. CLAUDE.md /
// rules resolve from here (see claude.js). Falls back to the bridge's cwd.
let termCwd = process.cwd();

// Static environment facts the harness shares with Claude each interaction.
const ENV_META = { shell: process.env.SHELL || null, os: process.platform };

// ---- workspace tools (Claude-Code-style harness) -----------------------
// Off by default. When on, Claude can use these tools scoped to the terminal's
// cwd. Read-only tools are auto-allowed; mutating tools (Bash/Edit/Write) are
// gated by a per-session allow-list, prompting the user otherwise.
const TOOLSET = ["Read", "Grep", "Glob", "LS", "Bash", "Edit", "Write", "MultiEdit"];
const READONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const tools = { on: false, allow: new Set() }; // allow = session-approved signatures
const pendingPerms = new Map(); // id -> resolver
let permSeq = 0;

function toolSignature(name, input) {
  if (name === "Bash") return "Bash:" + (input.command || "");
  if (["Edit", "Write", "MultiEdit"].includes(name))
    return name + ":" + (input.file_path || input.path || "");
  return name + ":*";
}
function toolDetail(name, input) {
  if (name === "Bash") return input.command || "";
  if (input.file_path || input.path) return input.file_path || input.path;
  return JSON.stringify(input).slice(0, 200);
}

// Permission callback handed to the Agent SDK. Returns a PermissionResult.
function makeCanUseTool() {
  return (name, input) => {
    if (READONLY_TOOLS.has(name)) return { behavior: "allow", updatedInput: input };
    const sig = toolSignature(name, input);
    if (tools.allow.has(sig) || tools.allow.has(name + ":*")) {
      return { behavior: "allow", updatedInput: input };
    }
    const id = "perm" + ++permSeq;
    broadcast({ type: "permission_request", id, name, detail: toolDetail(name, input), signature: sig });
    return new Promise((resolve) => {
      pendingPerms.set(id, (resp) => {
        if (resp.decision === "allow") {
          if (resp.scope === "session") tools.allow.add(sig);
          if (resp.scope === "session-tool") tools.allow.add(name + ":*");
          resolve({ behavior: "allow", updatedInput: input });
        } else {
          resolve({ behavior: "deny", message: "Denied by user." });
        }
      });
    });
  };
}

// One breaker shared across clients — the rate limit is account-wide.
const guard = new RateGuard();

// Chat history for conversational continuity (follow-up questions). Capped so
// it can't grow unbounded; claude.js also trims to a char budget per request.
let history = [];
const MAX_HISTORY_TURNS = 24; // 12 exchanges

// ---- watch mode --------------------------------------------------------
// Periodically summarize NEW terminal activity — but only when the buffer
// actually changed and the circuit is closed, so an idle terminal costs zero
// requests. Off by default; toggled by the client.
const WATCH_MIN_MS = 10000;
const WATCH_DEFAULT_MS = 10000;
const watch = { on: false, intervalMs: WATCH_DEFAULT_MS, timer: null, lastSig: null };
const sockets = new Set(); // connected clients' send fns, for broadcast

function bufferSignature() {
  const t = buffer.text;
  return t.length + ":" + t.slice(-80);
}

function broadcast(obj) {
  for (const send of sockets) {
    try {
      send(obj);
    } catch {
      /* ignore */
    }
  }
}

const WATCH_PROMPT =
  "Watch mode: in ONE short sentence, note anything noteworthy in the latest " +
  "terminal activity (a new error, a finished build, a risky command). If " +
  "nothing stands out, reply with exactly: (nothing).";

let watchBusy = false;
async function watchTick() {
  if (!watch.on || watchBusy) return;
  const sig = bufferSignature();
  if (sig === watch.lastSig) return; // nothing changed since last tick
  watch.lastSig = sig;
  watchBusy = true;
  try {
    let text = "";
    await guard.run(() =>
      ask({
        terminalContext: buffer.tail(),
        userMessage: WATCH_PROMPT,
        cwd: termCwd,
        history: [], // watch ticks are stateless
        meta: Object.assign({ mode: "watch" }, ENV_META),
        onChunk: (c) => (text += c),
      }),
    );
    const trimmed = text.trim();
    if (trimmed && !/^\(?\s*nothing\s*\)?\.?$/i.test(trimmed)) {
      broadcast({ type: "watch_update", text: trimmed });
    }
  } catch {
    // CircuitOpenError or transient — skip this tick silently.
  } finally {
    watchBusy = false;
  }
}

function armWatch() {
  if (watch.timer) clearInterval(watch.timer);
  watch.timer = null;
  if (watch.on) {
    watch.lastSig = null; // force a first look
    watch.timer = setInterval(watchTick, watch.intervalMs);
  }
}

function log(...a) {
  console.log(`[bridge ${new Date().toISOString()}]`, ...a);
}

// Stale socket file from a previous run blocks listen(); clear it.
try {
  fs.unlinkSync(SOCK);
} catch {
  /* not there — fine */
}

const server = net.createServer((sock) => {
  log("client connected");
  const send = (obj) => sock.write(encode(obj));
  sockets.add(send); // for watch-mode broadcasts

  const decode = createDecoder(async (msg) => {
    if (msg.type === "term_data") {
      buffer.append(msg.data || "");
      return;
    }
    if (msg.type === "cwd") {
      if (msg.dir) {
        termCwd = msg.dir;
        log(`cwd -> ${termCwd}`);
      }
      return;
    }
    if (msg.type === "clear") {
      history = [];
      log("history cleared");
      return;
    }
    if (msg.type === "tools") {
      tools.on = !!msg.on;
      if (!tools.on) tools.allow.clear(); // drop session approvals when disabled
      log(`tools ${tools.on ? "on" : "off"}`);
      broadcast({ type: "tools_state", on: tools.on });
      return;
    }
    if (msg.type === "permission_response") {
      const fn = pendingPerms.get(msg.id);
      if (fn) {
        pendingPerms.delete(msg.id);
        fn(msg);
      }
      return;
    }
    if (msg.type === "watch") {
      watch.on = !!msg.on;
      if (msg.intervalMs) {
        watch.intervalMs = Math.max(WATCH_MIN_MS, msg.intervalMs);
      }
      log(`watch ${watch.on ? "on" : "off"} (${watch.intervalMs}ms)`);
      armWatch();
      broadcast({ type: "watch_state", on: watch.on, intervalMs: watch.intervalMs });
      return;
    }
    if (msg.type === "chat_msg") {
      const text = (msg.text || "").trim();
      log(`chat_msg: ${JSON.stringify(text.slice(0, 80))}`);
      if (!text) return;
      try {
        const result = await guard.run(() =>
          ask({
            terminalContext: buffer.tail(),
            userMessage: text,
            cwd: termCwd,
            history,
            meta: Object.assign({ mode: "chat", tools: tools.on }, ENV_META),
            tools: tools.on
              ? {
                  enabled: true,
                  allowedTools: TOOLSET,
                  canUseTool: makeCanUseTool(),
                  onTool: (t) =>
                    send({ type: "tool_use", name: t.name, detail: toolDetail(t.name, t.input) }),
                }
              : null,
            onChunk: (chunk) => send({ type: "chat_stream", text: chunk }),
          }),
        );
        // Record the exchange for follow-up continuity.
        history.push({ role: "user", text });
        history.push({ role: "assistant", text: result?.text || "" });
        if (history.length > MAX_HISTORY_TURNS) {
          history = history.slice(history.length - MAX_HISTORY_TURNS);
        }
        send({ type: "chat_done" });
        log("chat_done");
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          // Rate-limited: tell the client when to try again, don't treat as a
          // hard error.
          log("rate-limited:", err.message);
          send({
            type: "rate_limited",
            error: err.message,
            retryAtMs: err.retryAtMs,
            rateLimitType: err.rateLimitType,
          });
        } else {
          log("chat_error:", err.message);
          send({ type: "chat_error", error: String(err.message || err) });
        }
      } finally {
        // Always surface the latest breaker/limit telemetry to the panel.
        send({ type: "rate_status", status: guard.status() });
      }
      return;
    }
    if (msg.type === "_parse_error") {
      log("bad frame:", msg.error);
    }
  });

  sock.on("data", decode);
  sock.on("error", (e) => log("socket error:", e.message));
  sock.on("close", () => {
    sockets.delete(send);
    log("client disconnected");
  });

  send({ type: "status", text: "connected to term-copilot bridge" });
  send({ type: "watch_state", on: watch.on, intervalMs: watch.intervalMs });
  send({ type: "tools_state", on: tools.on });
});

server.listen(SOCK, () => {
  log(`listening on ${SOCK}`);
  log(process.env.ANTHROPIC_API_KEY
    ? "auth: ANTHROPIC_API_KEY set (API billing!)"
    : "auth: subscription (no API key set)");
});

function shutdown() {
  log("shutting down");
  server.close();
  try {
    fs.unlinkSync(SOCK);
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
