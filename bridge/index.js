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
import { ask, COPILOT_PROMPT, harnessContext, CLAUDE_BIN } from "./claude.js";
import { RateGuard, CircuitOpenError } from "./rateguard.js";
import { LiveSession } from "./session.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const SOCK = process.env.TERM_COPILOT_SOCK || path.join(os.homedir(), ".term-copilot.sock");

// One shared buffer across all connected clients (a single terminal session for
// now; M3 can key buffers per session id).
// Large scrollback so the read_terminal tool can page far back, while we inject
// only a small slice into prompts. The tool is how the model sees more.
const buffer = new RollingBuffer(200000);

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
    if (READONLY_TOOLS.has(name) || name === TERMINAL_TOOL) {
      return { behavior: "allow", updatedInput: input };
    }
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

// ---- read_terminal tool ------------------------------------------------
// Lets the model page into the large scrollback on demand instead of us
// dumping it all into the prompt. Read-only, so it's auto-allowed.
const TERMINAL_TOOL = "mcp__terminal__read_terminal";

function readScrollback({ tail_lines, search, max_chars }) {
  const cap = Math.min(max_chars || 6000, 20000);
  let text = buffer.text;
  if (search) {
    const hits = text.split("\n").filter((l) => l.includes(search));
    text = hits.length ? hits.join("\n") : `(no lines contain "${search}")`;
  } else if (tail_lines) {
    text = text.split("\n").slice(-tail_lines).join("\n");
  }
  if (text.length > cap) text = "…(truncated)…\n" + text.slice(text.length - cap);
  return text || "(terminal buffer empty)";
}

const terminalServer = createSdkMcpServer({
  name: "terminal",
  version: "1.0.0",
  tools: [
    tool(
      "read_terminal",
      "Read more of the user's terminal scrollback than the snapshot you were given. " +
        "Use it to see earlier output that scrolled off, or to search the buffer.",
      {
        tail_lines: z.number().int().positive().optional().describe("Return the last N lines"),
        search: z.string().optional().describe("Return only lines containing this substring"),
        max_chars: z.number().int().positive().optional().describe("Max characters to return (default 6000)"),
      },
      async (args) => ({ content: [{ type: "text", text: readScrollback(args) }] }),
    ),
  ],
});

// ---- live session lifecycle --------------------------------------------
function buildSessionOptions() {
  const opts = {
    systemPrompt: COPILOT_PROMPT,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    cwd: termCwd || process.cwd(),
    settingSources: ["user", "project", "local"],
    maxTurns: tools.on ? 16 : 4, // a few turns so it can page the terminal then answer
    mcpServers: { terminal: terminalServer },
  };
  if (tools.on) {
    // Full harness: allow ALL discovered tools (built-in, skills, and any custom
    // MCP tools you've configured for Claude Code), gated by the approval flow —
    // read-only auto-allowed, everything else prompts (with session allow-list).
    opts.permissionMode = "default";
    opts.canUseTool = makeCanUseTool();
  } else {
    // Tools off: the model may still page the terminal (read-only), nothing else.
    opts.allowedTools = [TERMINAL_TOOL];
  }
  return opts;
}

let lastSlash = [];
function startLiveSession(resumeId) {
  if (session.live) return;
  session.firstTurn = true;
  session.id = resumeId || null;
  const options = buildSessionOptions();
  if (resumeId) options.resume = resumeId;
  session.live = new LiveSession(options, {
    onSessionId: (id) => {
      session.id = id;
    },
    onChunk: (t) => broadcast({ type: "chat_stream", text: t }),
    onTool: (t) => broadcast({ type: "tool_use", name: t.name, detail: toolDetail(t.name, t.input) }),
    onResult: () => broadcast({ type: "chat_done" }),
    onContext: (cu) =>
      broadcast({
        type: "context",
        session: true,
        tokens: cu.totalTokens,
        max: cu.maxTokens,
        percentage: cu.percentage,
        categories: (cu.categories || []).map((c) => ({ name: c.name, tokens: c.tokens, color: c.color })),
      }),
    onSlash: (cmds) => {
      lastSlash = cmds;
      broadcast({ type: "slash_commands", commands: cmds });
    },
    onRate: (info) =>
      broadcast({ type: "rate_limited", error: "rate limited (" + (info.rateLimitType || "?") + ")", rateLimitType: info.rateLimitType }),
    onError: (e) => {
      log("session error:", e.message);
      broadcast({ type: "chat_error", error: String(e.message || e) });
    },
  });
  session.live.start();
  log("live session started");
}

function stopLiveSession() {
  if (session.live) {
    session.live.stop();
    session.live = null;
    session.id = null;
    lastSlash = [];
    log("live session stopped");
  }
}

// One breaker shared across clients — the rate limit is account-wide.
const guard = new RateGuard();

// Chat history for conversational continuity (follow-up questions). Capped so
// it can't grow unbounded; claude.js also trims to a char budget per request.
let history = [];
const MAX_HISTORY_TURNS = 24; // 12 exchanges

// ---- session mode (running context window) -----------------------------
// Off by default (cheap stateless Q&A). When on, a LiveSession keeps one
// streaming query alive — the running context window — with segmented usage and
// slash commands. SDK auto-compacts it when full (CLAUDE.md preserved).
const session = { on: false, live: null, firstTurn: true, id: null };

// Saved sessions: friendly name -> SDK session id, persisted so you can recall a
// past conversation later via the SDK's resume.
const STORE_DIR = path.join(os.homedir(), ".term-copilot");
const SESSIONS_FILE = path.join(STORE_DIR, "sessions.json");

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveSessions(list) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    log("sessions save failed:", e.message);
  }
}
let savedSessions = loadSessions();

// Claude Code's project dir for a cwd (slashes/dots → dashes).
function encodeProject(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// List recent sessions on disk for a directory (Claude Code auto-persists every
// session), newest first, labeled by their first user message. This is what
// makes resume work without a manual save — like Claude Code's /resume.
function diskSessions(cwd) {
  const dir = path.join(os.homedir(), ".claude", "projects", encodeProject(cwd));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl$/, "");
    const p = path.join(dir, f);
    let savedAt = 0;
    let label = "";
    try {
      savedAt = fs.statSync(p).mtimeMs;
      // Read only the head to find the first real user message (files get big).
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      for (const line of buf.toString("utf8", 0, n).split("\n")) {
        if (!line.trim()) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (r.type === "user" && r.message) {
          const c = r.message.content;
          let t =
            typeof c === "string"
              ? c
              : Array.isArray(c)
                ? c.filter((b) => b.type === "text").map((b) => b.text).join("")
                : "";
          t = t.replace(/<recent_terminal_output>[\s\S]*?<\/recent_terminal_output>/g, "");
          const i = t.lastIndexOf("\nUser: ");
          if (i !== -1) t = t.slice(i + 7);
          t = t.trim();
          if (t) { label = t.slice(0, 60); break; }
        }
      }
    } catch {
      /* skip unreadable */
    }
    out.push({ sessionId, label: label || "(no preview)", savedAt });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out.slice(0, 25);
}

function sessionsPayload() {
  return { type: "sessions", list: savedSessions, recent: diskSessions(termCwd) };
}

// Read Claude Code's on-disk transcript for a session id so the panel can
// repaint the prior conversation on resume. Returns [{role, text}].
function readTranscript(sessionId) {
  const base = path.join(os.homedir(), ".claude", "projects");
  let file = null;
  try {
    for (const dir of fs.readdirSync(base)) {
      const p = path.join(base, dir, sessionId + ".jsonl");
      if (fs.existsSync(p)) { file = p; break; }
    }
  } catch {
    return [];
  }
  if (!file) return [];
  const out = [];
  // Our injected user turns wrap the real text as "…\n\nUser: <text>"; unwrap it.
  const unwrap = (t) => {
    const i = t.lastIndexOf("\nUser: ");
    return i !== -1 ? t.slice(i + 7) : t;
  };
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "user" && rec.message) {
      const c = rec.message.content;
      let text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b) => b.type === "text").map((b) => b.text).join("")
            : "";
      text = unwrap(text).trim();
      if (text) out.push({ role: "user", text });
    } else if (rec.type === "assistant" && rec.message) {
      for (const b of rec.message.content || []) {
        if (b.type === "text" && b.text.trim()) out.push({ role: "assistant", text: b.text });
        else if (b.type === "tool_use") out.push({ role: "tool", text: b.name });
      }
    }
  }
  return out.slice(-200); // cap the repaint
}

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
        terminalContext: buffer.tail(8000),
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
    if (msg.type === "session") {
      session.on = !!msg.on;
      if (session.on) startLiveSession();
      else stopLiveSession();
      log(`session ${session.on ? "on" : "off"}`);
      broadcast({ type: "session_state", on: session.on });
      return;
    }
    if (msg.type === "session_list") {
      send(sessionsPayload());
      return;
    }
    if (msg.type === "session_save") {
      // Name a session (the current live one, or any id from the recent list).
      // Upsert by id — you can't save the same session twice; a new name renames.
      const name = (msg.name || "").trim();
      const id = msg.sessionId || session.id;
      if (!name || !id) {
        send(sessionsPayload());
        return;
      }
      savedSessions = savedSessions.filter((s) => s.sessionId !== id);
      savedSessions.unshift({ name, sessionId: id, cwd: termCwd, savedAt: Date.now() });
      saveSessions(savedSessions);
      log(`session saved: ${name} (${id})`);
      broadcast(sessionsPayload());
      return;
    }
    if (msg.type === "session_delete") {
      // Removes the bookmark only; the on-disk transcript is untouched.
      savedSessions = savedSessions.filter((s) => s.sessionId !== msg.sessionId);
      saveSessions(savedSessions);
      broadcast(sessionsPayload());
      return;
    }
    if (msg.type === "session_resume") {
      if (!msg.sessionId) return;
      stopLiveSession();
      session.on = true;
      startLiveSession(msg.sessionId);
      const saved = savedSessions.find((s) => s.sessionId === msg.sessionId);
      const name = saved ? saved.name : "session";
      log(`session resumed: ${name}`);
      broadcast({ type: "session_state", on: true });
      // Repaint the prior conversation from the on-disk transcript.
      broadcast({ type: "transcript", name, messages: readTranscript(msg.sessionId) });
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

      // Session mode: route through the live streaming session. A leading "/"
      // is sent verbatim so the SDK executes it as a slash command.
      if (session.on) {
        if (!session.live) startLiveSession();
        if (text.startsWith("/")) {
          session.live.send(text);
        } else if (session.firstTurn) {
          session.firstTurn = false;
          session.live.send(
            harnessContext({ cwd: termCwd, shell: ENV_META.shell, os: ENV_META.os, mode: "chat" }) +
              `<recent_terminal_output>\n${buffer.tail(4000)}\n</recent_terminal_output>\n\nUser: ${text}`,
          );
        } else {
          session.live.send(
            `<recent_terminal_output>\n${buffer.tail(1500)}\n</recent_terminal_output>\n\nUser: ${text}`,
          );
        }
        log(`session msg: ${JSON.stringify(text.slice(0, 60))}`);
        return;
      }

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
        // Stateless: keep our own trimmed transcript for replay.
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
  send({ type: "session_state", on: session.on });
  send(sessionsPayload());
  if (lastSlash.length) send({ type: "slash_commands", commands: lastSlash });
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
