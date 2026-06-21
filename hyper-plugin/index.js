// hyper-term-copilot — a Claude copilot side panel for Hyper.
//
// Two responsibilities:
//   1. middleware: tap the terminal's pty output and cwd changes from Hyper's
//      Redux actions and forward them to the bridge (term_data / cwd frames).
//   2. decorateHyper: render a chat side panel next to the terminal that sends
//      chat_msg frames and renders streamed chat_stream / rate_status replies.
//
// The bridge does the rest (rolling buffer, CLAUDE.md context, RateGuard, Claude).
// UI is written with React.createElement (no JSX) so it needs no build step.

const client = require("./client.js");
const { makeRenderer } = require("./markdown.js");

const PANEL_W = 380;

// Captured from middleware — Hyper's Redux store, used to find the active
// session and write into its pty.
let hyperStore = null;

// Write text into the ACTIVE terminal session's pty, wrapped in bracketed-paste
// markers (ESC[200~ … ESC[201~) so multi-line snippets land at the prompt for
// review instead of auto-executing. Uses the same rpc 'data' path keystrokes
// take (window.rpc is exposed by Hyper).
function writeToTerminal(text) {
  try {
    if (!hyperStore || !text) return;
    const uid = hyperStore.getState().sessions.activeUid;
    if (!uid) return;
    const data = "\x1b[200~" + text + "\x1b[201~";
    if (typeof window !== "undefined" && window.rpc) {
      window.rpc.emit("data", { uid, data });
    } else {
      // Fallback: dispatch the user-data action with an rpc effect.
      hyperStore.dispatch({
        type: "SESSION_USER_DATA",
        data,
        effect() {
          if (typeof window !== "undefined" && window.rpc) {
            window.rpc.emit("data", { uid, data });
          }
        },
      });
    }
  } catch {
    /* never break the terminal */
  }
}

// ---------------------------------------------------------------------------
// 0. Reserve space for the panel. Hyper positions its terminal container
//    (.terms_terms) absolutely filling the window, so a flexbox sibling won't
//    shrink it. Instead we inset the terminal from the right by the panel
//    width via injected CSS, and pin the panel itself `fixed` on the right.
// ---------------------------------------------------------------------------
exports.decorateConfig = (config) => {
  const css = `
    .terms_terms { right: ${PANEL_W}px !important; }
  `;
  return Object.assign({}, config, { css: (config.css || "") + css });
};

// ---------------------------------------------------------------------------
// 1. Middleware — observe terminal output + cwd, forward to the bridge.
// ---------------------------------------------------------------------------
exports.middleware = (store) => (next) => (action) => {
  hyperStore = store; // capture for writeToTerminal
  try {
    // Incoming pty output for a session.
    if (action.type === "SESSION_ADD_DATA" && action.data) {
      client.connect();
      client.send({ type: "term_data", data: action.data });
    }
    // Shell-integration cwd updates (OSC 7). Lets CLAUDE.md resolve from the
    // directory you're actually working in.
    if (action.type === "SESSION_SET_CWD" && action.cwd) {
      client.send({ type: "cwd", dir: action.cwd });
    }
  } catch {
    /* never let the plugin break the terminal */
  }
  return next(action);
};

// ---------------------------------------------------------------------------
// 2. UI — a chat side panel wrapping the Hyper root component.
// ---------------------------------------------------------------------------
exports.decorateHyper = (Hyper, { React }) => {
  const h = React.createElement;
  const renderMarkdown = makeRenderer(React, { onInsertCode: writeToTerminal });

  class ChatPanel extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        messages: [], // { role: 'user' | 'assistant', text }
        input: "",
        streaming: false,
        connected: false,
        rate: null, // latest rate_status.status
        watchOn: false,
        watchText: "", // latest watch_update note
        intervalMs: 10000, // watch cadence
      };
      this.onSubmit = this.onSubmit.bind(this);
      this.onInput = this.onInput.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onClear = this.onClear.bind(this);
      this.onHotkey = this.onHotkey.bind(this);
      this.onToggleWatch = this.onToggleWatch.bind(this);
      this.onChangeInterval = this.onChangeInterval.bind(this);
    }

    componentDidMount() {
      client.connect();
      // "Look at this" — Cmd+Shift+L focuses the panel and asks about the
      // current screen using the buffer the bridge already has.
      window.addEventListener("keydown", this.onHotkey, true);
      this._bind("connected", () => this.setState({ connected: true }));
      this._bind("disconnected", () => this.setState({ connected: false }));
      this._bind("chat_stream", (m) => this._appendToAssistant(m.text));
      this._bind("chat_done", () => this.setState({ streaming: false }));
      this._bind("chat_error", (m) => {
        this._appendToAssistant(`\n[error] ${m.error}`);
        this.setState({ streaming: false });
      });
      this._bind("rate_limited", (m) => {
        this._appendToAssistant(`\n⚠ ${m.error}`);
        this.setState({ streaming: false });
      });
      this._bind("rate_status", (m) => this.setState({ rate: m.status }));
      this._bind("watch_state", (m) =>
        this.setState({ watchOn: !!m.on, intervalMs: m.intervalMs || this.state.intervalMs }),
      );
      this._bind("watch_update", (m) => this.setState({ watchText: m.text }));
    }

    componentWillUnmount() {
      (this._handlers || []).forEach(([ev, fn]) => client.removeListener(ev, fn));
      window.removeEventListener("keydown", this.onHotkey, true);
    }

    onHotkey(e) {
      if (e.metaKey && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        this._ask("Look at what's on my screen right now and explain it.");
      }
    }

    onClear() {
      client.send({ type: "clear" });
      this.setState({ messages: [], streaming: false });
    }

    onToggleWatch() {
      const on = !this.state.watchOn;
      this.setState({ watchOn: on });
      client.send({ type: "watch", on, intervalMs: this.state.intervalMs });
    }

    onChangeInterval(e) {
      const intervalMs = parseInt(e.target.value, 10);
      this.setState({ intervalMs });
      // If watching, re-arm at the new cadence; otherwise just remember it.
      if (this.state.watchOn) client.send({ type: "watch", on: true, intervalMs });
    }

    // Send a message programmatically (used by the hotkey and the input).
    _ask(text) {
      if (!text || this.state.streaming) return;
      this.setState((s) => ({
        messages: s.messages.concat([{ role: "user", text }]),
        input: "",
        streaming: true,
      }));
      client.send({ type: "chat_msg", text });
      if (this._taEl) this._taEl.focus();
    }

    _bind(ev, fn) {
      (this._handlers = this._handlers || []).push([ev, fn]);
      client.on(ev, fn);
    }

    _appendToAssistant(text) {
      this.setState((s) => {
        const msgs = s.messages.slice();
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          msgs[msgs.length - 1] = { role: "assistant", text: last.text + text };
        } else {
          msgs.push({ role: "assistant", text });
        }
        return { messages: msgs };
      });
    }

    onInput(e) {
      this.setState({ input: e.target.value });
    }

    onKeyDown(e) {
      // Enter sends; Shift+Enter newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.onSubmit();
      }
    }

    onSubmit() {
      this._ask(this.state.input.trim());
    }

    _rateLabel() {
      const r = this.state.rate;
      if (!this.state.connected) return "● offline — is the bridge running?";
      if (!r) return "● ready";
      if (r.state === "open" && r.openUntil) {
        const when = new Date(r.openUntil).toLocaleTimeString();
        return `● rate-limited (${r.rateLimitType || "?"}) — back ${when}`;
      }
      const util = r.rateInfo && r.rateInfo.utilization;
      return util != null ? `● ${Math.round(util)}% of window used` : "● ready";
    }

    render() {
      const S = STYLES;
      const rows = this.state.messages.map((m, i) => {
        if (m.role === "user") {
          return h("div", { key: i, style: S.userMsg }, m.text);
        }
        const body =
          m.text
            ? renderMarkdown(m.text)
            : this.state.streaming
              ? "…"
              : "";
        return h("div", { key: i, style: S.botMsg }, body);
      });
      const watchBtnStyle = Object.assign(
        {},
        S.clearBtn,
        this.state.watchOn ? S.watchBtnOn : null,
      );
      return h("div", { style: S.panel }, [
        h("div", { key: "hd", style: S.header }, [
          h("span", { key: "t" }, "◇ copilot"),
          h("span", { key: "btns" }, [
            h("button", { key: "w", style: watchBtnStyle, onClick: this.onToggleWatch, title: "Watch mode: auto-summarize new activity" },
              this.state.watchOn ? "● watching" : "watch"),
            h("select", {
              key: "iv",
              style: Object.assign({ marginLeft: 6 }, S.intervalSel),
              value: String(this.state.intervalMs),
              onChange: this.onChangeInterval,
              title: "Watch interval",
            }, [
              h("option", { key: "10", value: "10000" }, "10s"),
              h("option", { key: "30", value: "30000" }, "30s"),
              h("option", { key: "60", value: "60000" }, "60s"),
            ]),
            h("button", { key: "c", style: Object.assign({ marginLeft: 6 }, S.clearBtn), onClick: this.onClear, title: "Clear conversation" }, "clear"),
          ]),
        ]),
        h("div", { key: "st", style: S.status }, this._rateLabel() + "   ·   ⌘⇧L: look at screen"),
        this.state.watchOn && this.state.watchText
          ? h("div", { key: "wb", style: S.watchBanner }, "👁  " + this.state.watchText)
          : null,
        h("div", { key: "ms", style: S.messages, ref: (el) => (this._msgEl = el) }, rows),
        h("div", { key: "in", style: S.inputRow }, [
          h("textarea", {
            key: "ta",
            style: S.textarea,
            value: this.state.input,
            placeholder: this.state.streaming ? "…thinking" : "Ask about your terminal…",
            onChange: this.onInput,
            onKeyDown: this.onKeyDown,
            ref: (el) => (this._taEl = el),
            rows: 2,
          }),
          h("button", { key: "bt", style: S.button, onClick: this.onSubmit }, "Send"),
        ]),
      ]);
    }

    componentDidUpdate() {
      if (this._msgEl) this._msgEl.scrollTop = this._msgEl.scrollHeight;
    }
  }

  // Render Hyper untouched + the copilot panel pinned `fixed` on the right
  // (the terminal already reserves PANEL_W via decorateConfig CSS).
  return class CopilotHyper extends React.Component {
    render() {
      return h(React.Fragment, null, [
        h(Hyper, Object.assign({ key: "hyper" }, this.props)),
        h(ChatPanel, { key: "panel" }),
      ]);
    }
  };
};

// ---------------------------------------------------------------------------
// Styling — inline so there's no CSS build step.
// ---------------------------------------------------------------------------
const STYLES = {
  panel: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: PANEL_W,
    zIndex: 100,
    display: "flex",
    flexDirection: "column",
    background: "#10131a",
    borderLeft: "1px solid #2a2f3a",
    color: "#cdd3de",
    fontFamily: "-apple-system, Menlo, monospace",
    fontSize: 12.5,
  },
  header: {
    padding: "10px 12px",
    fontWeight: 600,
    color: "#8ab4f8",
    letterSpacing: 1,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  clearBtn: {
    background: "transparent",
    color: "#7e8796",
    border: "1px solid #2a2f3a",
    borderRadius: 5,
    fontSize: 10,
    padding: "2px 8px",
    cursor: "pointer",
    letterSpacing: 0,
  },
  watchBtnOn: { color: "#7ee0a1", borderColor: "#2e6f4a", background: "#10261a" },
  intervalSel: {
    background: "#10131a",
    color: "#7e8796",
    border: "1px solid #2a2f3a",
    borderRadius: 5,
    fontSize: 10,
    padding: "1px 4px",
    cursor: "pointer",
  },
  watchBanner: {
    margin: "0 12px 8px",
    padding: "6px 9px",
    background: "#12241c",
    border: "1px solid #234a35",
    borderRadius: 6,
    color: "#bfe9cd",
    fontSize: 11.5,
    whiteSpace: "pre-wrap",
  },
  status: { padding: "0 12px 8px", fontSize: 11, color: "#7e8796" },
  messages: { flex: 1, overflowY: "auto", padding: "4px 12px", lineHeight: 1.5 },
  userMsg: {
    whiteSpace: "pre-wrap",
    margin: "8px 0",
    padding: "6px 9px",
    background: "#1c2230",
    borderRadius: 6,
    color: "#e7ecf5",
  },
  botMsg: { whiteSpace: "pre-wrap", margin: "8px 0", padding: "2px 0", color: "#c2c9d6" },
  inputRow: { display: "flex", padding: 8, gap: 6, borderTop: "1px solid #2a2f3a" },
  textarea: {
    flex: 1,
    resize: "none",
    background: "#0b0e14",
    color: "#e7ecf5",
    border: "1px solid #2a2f3a",
    borderRadius: 6,
    padding: 6,
    fontFamily: "inherit",
    fontSize: 12.5,
  },
  button: {
    background: "#2b6cf6",
    color: "#fff",
    border: 0,
    borderRadius: 6,
    padding: "0 14px",
    cursor: "pointer",
  },
};
