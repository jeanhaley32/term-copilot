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

// One breaker shared across clients — the rate limit is account-wide.
const guard = new RateGuard();

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
    if (msg.type === "chat_msg") {
      const text = (msg.text || "").trim();
      log(`chat_msg: ${JSON.stringify(text.slice(0, 80))}`);
      if (!text) return;
      try {
        await guard.run(() =>
          ask({
            terminalContext: buffer.tail(),
            userMessage: text,
            cwd: termCwd,
            onChunk: (chunk) => send({ type: "chat_stream", text: chunk }),
          }),
        );
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
  sock.on("close", () => log("client disconnected"));

  send({ type: "status", text: "connected to term-copilot bridge" });
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
