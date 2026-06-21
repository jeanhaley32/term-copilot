// Bridge client for the Hyper plugin (CommonJS — Hyper plugins are CJS).
//
// A singleton that connects to the term-copilot bridge's Unix socket, speaks
// the same NDJSON protocol as bridge/protocol.js, auto-reconnects, and emits
// incoming frames as events the React panel subscribes to.

const net = require("net");
const os = require("os");
const path = require("path");
const EventEmitter = require("events");

const SOCK =
  process.env.TERM_COPILOT_SOCK || path.join(os.homedir(), ".term-copilot.sock");

function encode(obj) {
  return JSON.stringify(obj) + "\n";
}

class BridgeClient extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.sock = null;
    this.connected = false;
    this.buf = "";
    this.reconnectMs = 1000;
  }

  connect() {
    if (this.sock) return; // already connecting/connected
    const sock = net.createConnection(SOCK);
    this.sock = sock;

    sock.on("connect", () => {
      this.connected = true;
      this.reconnectMs = 1000;
      this.emit("connected");
    });

    sock.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type) this.emit(msg.type, msg);
      }
    });

    const drop = () => {
      this.connected = false;
      this.sock = null;
      this.emit("disconnected");
      // Exponential-ish reconnect, capped at 15s.
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 15000);
    };
    sock.on("error", drop);
    sock.on("close", drop);
  }

  send(obj) {
    if (this.connected && this.sock) {
      try {
        this.sock.write(encode(obj));
      } catch {
        /* will reconnect */
      }
    }
  }
}

// One shared instance for the whole renderer.
module.exports = new BridgeClient();
