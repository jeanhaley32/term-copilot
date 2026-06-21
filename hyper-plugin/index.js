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

// ---------------------------------------------------------------------------
// 1. Middleware — observe terminal output + cwd, forward to the bridge.
// ---------------------------------------------------------------------------
exports.middleware = (store) => (next) => (action) => {
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

  class ChatPanel extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        messages: [], // { role: 'user' | 'assistant', text }
        input: "",
        streaming: false,
        connected: false,
        rate: null, // latest rate_status.status
      };
      this.onSubmit = this.onSubmit.bind(this);
      this.onInput = this.onInput.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
    }

    componentDidMount() {
      client.connect();
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
    }

    componentWillUnmount() {
      (this._handlers || []).forEach(([ev, fn]) => client.removeListener(ev, fn));
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
      const text = this.state.input.trim();
      if (!text || this.state.streaming) return;
      this.setState((s) => ({
        messages: s.messages.concat([{ role: "user", text }]),
        input: "",
        streaming: true,
      }));
      client.send({ type: "chat_msg", text });
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
      const rows = this.state.messages.map((m, i) =>
        h("div", { key: i, style: m.role === "user" ? S.userMsg : S.botMsg },
          m.text || (m.role === "assistant" && this.state.streaming ? "…" : "")),
      );
      return h("div", { style: S.panel }, [
        h("div", { key: "hd", style: S.header }, "◇ copilot"),
        h("div", { key: "st", style: S.status }, this._rateLabel()),
        h("div", { key: "ms", style: S.messages, ref: (el) => (this._msgEl = el) }, rows),
        h("div", { key: "in", style: S.inputRow }, [
          h("textarea", {
            key: "ta",
            style: S.textarea,
            value: this.state.input,
            placeholder: this.state.streaming ? "…thinking" : "Ask about your terminal…",
            onChange: this.onInput,
            onKeyDown: this.onKeyDown,
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

  // Wrap Hyper: terminal on the left (flex), copilot panel pinned right.
  return class CopilotHyper extends React.Component {
    render() {
      return h("div", { style: STYLES.root }, [
        h("div", { key: "term", style: STYLES.termWrap }, h(Hyper, this.props)),
        h(ChatPanel, { key: "panel" }),
      ]);
    }
  };
};

// ---------------------------------------------------------------------------
// Styling — inline so there's no CSS build step.
// ---------------------------------------------------------------------------
const STYLES = {
  root: { display: "flex", flexDirection: "row", width: "100%", height: "100%" },
  termWrap: { flex: 1, position: "relative", minWidth: 0 },
  panel: {
    width: 380,
    minWidth: 380,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: "#10131a",
    borderLeft: "1px solid #2a2f3a",
    color: "#cdd3de",
    fontFamily: "-apple-system, Menlo, monospace",
    fontSize: 12.5,
  },
  header: { padding: "10px 12px", fontWeight: 600, color: "#8ab4f8", letterSpacing: 1 },
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
