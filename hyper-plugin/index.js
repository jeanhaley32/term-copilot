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

const PANEL_W = 380; // default width
const PANEL_MIN = 260;
const PANEL_MAX = 900;
const WIDTH_KEY = "termCopilotWidth";
const PALETTE = ["#5aa9e6", "#e6b673", "#7ee0a1", "#c08af0", "#e08a8a", "#6fd0d0"];
// Shown immediately when session turns on; replaced by the live list from the
// SDK once the first message fires its init (which carries the real commands).
const DEFAULT_SLASH = [
  "compact", "context", "clear", "usage", "config", "review",
  "security-review", "init", "insights",
];

function savedWidth() {
  try {
    const w = parseInt(window.localStorage.getItem(WIDTH_KEY), 10);
    if (w >= PANEL_MIN && w <= PANEL_MAX) return w;
  } catch {
    /* ignore */
  }
  return PANEL_W;
}

// Captured from middleware — Hyper's Redux store, used to find the active
// session and write into its pty.
let hyperStore = null;

// Write text into the ACTIVE terminal session's pty, wrapped in bracketed-paste
// markers (ESC[200~ … ESC[201~) so multi-line snippets land at the prompt for
// review instead of auto-executing. Uses the same rpc 'data' path keystrokes
// take (window.rpc is exposed by Hyper).
function writeToTerminal(text, run) {
  try {
    if (!hyperStore || !text) return;
    const uid = hyperStore.getState().sessions.activeUid;
    if (!uid) return;
    // Bracketed paste so multi-line snippets land intact; append CR to execute.
    const data = "\x1b[200~" + text + "\x1b[201~" + (run ? "\r" : "");
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
  const renderMarkdown = makeRenderer(React, {
    onInsertCode: (code) => writeToTerminal(code, false),
    onRunCode: (code) => writeToTerminal(code, true),
  });

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
        toolsOn: false,
        perm: null, // pending permission request { id, name, detail, signature }
        width: savedWidth(),
        sessionOn: false,
        ctx: null, // { tokens, max, percentage, categories }
        slashCommands: DEFAULT_SLASH, // seeded; replaced by the live list on init
        slashSel: 0, // highlighted index in the slash popup
        slashHidden: false, // dismissed with Esc until next keystroke
        sessions: [], // saved/named sessions [{ name, sessionId, cwd, savedAt }]
        recentSessions: [], // recent sessions from disk [{ sessionId, label, savedAt }]
        showSessions: false,
        saveName: "",
        renameTarget: null, // session id being named/renamed (null = name current)
      };
      this.onToggleSession = this.onToggleSession.bind(this);
      this.onToggleSessions = this.onToggleSessions.bind(this);
      this.onSaveSession = this.onSaveSession.bind(this);
      this.onDragStart = this.onDragStart.bind(this);
      this._onDrag = this._onDrag.bind(this);
      this._endDrag = this._endDrag.bind(this);
      this.onSubmit = this.onSubmit.bind(this);
      this.onInput = this.onInput.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onClear = this.onClear.bind(this);
      this.onHotkey = this.onHotkey.bind(this);
      this.onToggleWatch = this.onToggleWatch.bind(this);
      this.onChangeInterval = this.onChangeInterval.bind(this);
      this.onToggleTools = this.onToggleTools.bind(this);
      this.respondPerm = this.respondPerm.bind(this);
    }

    componentDidMount() {
      client.connect();
      // "Look at this" — Cmd+Shift+L focuses the panel and asks about the
      // current screen using the buffer the bridge already has.
      window.addEventListener("keydown", this.onHotkey, true);
      // Inset the terminal by the (resizable) panel width via an injected style
      // tag we update live while dragging — overrides the static decorateConfig
      // rule because it's inserted later.
      this._styleEl = document.createElement("style");
      this._styleEl.id = "term-copilot-inset";
      document.head.appendChild(this._styleEl);
      this._applyWidth(this.state.width);
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
      this._bind("tools_state", (m) => this.setState({ toolsOn: !!m.on }));
      this._bind("tool_use", (m) =>
        this.setState((s) => ({
          messages: s.messages.concat([
            { role: "tool", text: m.name + (m.detail ? " · " + m.detail : "") },
          ]),
        })),
      );
      this._bind("permission_request", (m) => this.setState({ perm: m }));
      this._bind("session_state", (m) => this.setState({ sessionOn: !!m.on }));
      this._bind("context", (m) => this.setState({ ctx: m }));
      this._bind("slash_commands", (m) => {
        if (Array.isArray(m.commands) && m.commands.length) this.setState({ slashCommands: m.commands });
      });
      this._bind("sessions", (m) =>
        this.setState({ sessions: m.list || [], recentSessions: m.recent || [] }),
      );
      this._bind("transcript", (m) =>
        this.setState({
          messages: (m.messages || []).concat([
            { role: "note", text: "↩ resumed: " + (m.name || "session") },
          ]),
          showSessions: false,
        }),
      );
    }

    componentWillUnmount() {
      (this._handlers || []).forEach(([ev, fn]) => client.removeListener(ev, fn));
      window.removeEventListener("keydown", this.onHotkey, true);
      this._endDrag();
      if (this._styleEl && this._styleEl.parentNode) this._styleEl.parentNode.removeChild(this._styleEl);
    }

    // Push the current width to the injected stylesheet + persist it.
    _applyWidth(w) {
      if (this._styleEl) this._styleEl.textContent = `.terms_terms{right:${w}px !important;}`;
      try {
        window.localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        /* ignore */
      }
    }

    onDragStart(e) {
      e.preventDefault();
      window.addEventListener("mousemove", this._onDrag, true);
      window.addEventListener("mouseup", this._endDrag, true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    }

    _onDrag(e) {
      let w = window.innerWidth - e.clientX;
      const max = Math.min(PANEL_MAX, window.innerWidth - 200);
      w = Math.max(PANEL_MIN, Math.min(max, w));
      this.setState({ width: w });
      this._applyWidth(w);
    }

    _endDrag() {
      window.removeEventListener("mousemove", this._onDrag, true);
      window.removeEventListener("mouseup", this._endDrag, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }

    onHotkey(e) {
      if (e.metaKey && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        this._ask(
          "(Take a quick look at what's on my screen now and factor it into what we're discussing — no need to explain it from scratch.)",
          { hidden: true },
        );
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

    // Slash commands matching what's typed (session mode only).
    _slashMatches() {
      if (!this.state.sessionOn || this.state.slashHidden) return [];
      const v = this.state.input;
      if (!v.startsWith("/") || /\s/.test(v)) return []; // only while typing the name
      const q = v.slice(1).toLowerCase();
      return this.state.slashCommands.filter((c) => c.toLowerCase().includes(q)).slice(0, 10);
    }

    _pickSlash(cmd) {
      this.setState({ input: "/" + cmd + " ", slashSel: 0 });
      if (this._taEl) this._taEl.focus();
    }

    onChangeInterval(e) {
      const intervalMs = parseInt(e.target.value, 10);
      this.setState({ intervalMs });
      // If watching, re-arm at the new cadence; otherwise just remember it.
      if (this.state.watchOn) client.send({ type: "watch", on: true, intervalMs });
    }

    onToggleSession() {
      const on = !this.state.sessionOn;
      this.setState({ sessionOn: on, ctx: on ? this.state.ctx : null });
      client.send({ type: "session", on });
    }

    onToggleSessions() {
      const show = !this.state.showSessions;
      if (show) client.send({ type: "session_list" });
      this.setState({ showSessions: show });
    }

    onSaveSession() {
      const name = this.state.saveName.trim();
      if (!name) return;
      // renameTarget set → name that specific session; else the current live one.
      client.send({ type: "session_save", name, sessionId: this.state.renameTarget || undefined });
      this.setState({ saveName: "", renameTarget: null });
    }

    _startRename(sessionId, name) {
      this.setState({ renameTarget: sessionId, saveName: name || "" });
    }

    _resumeSession(sessionId) {
      client.send({ type: "session_resume", sessionId });
    }

    _deleteSession(sessionId) {
      client.send({ type: "session_delete", sessionId });
    }

    onToggleTools() {
      const on = !this.state.toolsOn;
      this.setState({ toolsOn: on });
      client.send({ type: "tools", on });
    }

    respondPerm(decision, scope) {
      const p = this.state.perm;
      if (!p) return;
      client.send({ type: "permission_response", id: p.id, decision, scope });
      this.setState({ perm: null });
    }

    // Send a message programmatically. `hidden` sends the prompt to the model
    // without showing it as a user bubble — for button-triggered nudges like
    // ⌘⇧L, where the prompt is plumbing, not part of the conversation. We push
    // an empty assistant placeholder so its reply renders as a fresh turn.
    _ask(text, opts) {
      if (!text || this.state.streaming) return;
      const hidden = opts && opts.hidden;
      this.setState((s) => ({
        messages: s.messages.concat([hidden ? { role: "assistant", text: "" } : { role: "user", text }]),
        input: hidden ? s.input : "",
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
      this.setState({ input: e.target.value, slashSel: 0, slashHidden: false });
    }

    onKeyDown(e) {
      const matches = this._slashMatches();
      // Slash popup is open → arrow keys navigate, Enter/Tab pick, Esc dismiss.
      if (matches.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.setState((s) => ({ slashSel: Math.min(s.slashSel + 1, matches.length - 1) }));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.setState((s) => ({ slashSel: Math.max(s.slashSel - 1, 0) }));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this._pickSlash(matches[Math.min(this.state.slashSel, matches.length - 1)]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.setState({ slashHidden: true });
          return;
        }
      }
      // Enter sends; Shift+Enter newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.onSubmit();
      }
    }

    onSubmit() {
      this._ask(this.state.input.trim());
    }

    _renderMeter() {
      const h = React.createElement;
      const ctx = this.state.ctx;
      const cats = (ctx.categories || []).filter((c) => c.name !== "Free space" && c.tokens > 0);
      const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(0) + "K" : String(n));
      const maxLbl = ctx.max >= 1e6 ? (ctx.max / 1e6).toFixed(1) + "M" : fmt(ctx.max);
      // honest fill bar: each category's slice of the full window
      const segs = cats.map((c, i) =>
        h("div", {
          key: i,
          title: `${c.name}: ${c.tokens.toLocaleString()}`,
          style: {
            height: "100%",
            width: Math.max(0.3, (c.tokens / ctx.max) * 100) + "%",
            background: c.color || PALETTE[i % PALETTE.length],
          },
        }),
      );
      // legend: top categories by tokens
      const legend = cats
        .slice()
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 4)
        .map((c) => `${c.name} ${fmt(c.tokens)}`)
        .join(" · ");
      return h("div", { key: "ctx", style: STYLES.ctxWrap }, [
        h("div", { key: "lbl", style: STYLES.ctxLabel },
          `context ${ctx.percentage}% · ${fmt(ctx.tokens)} / ${maxLbl}${ctx.percentage >= 80 ? "  ⚠ compaction near" : ""}`),
        h("div", { key: "bar", style: STYLES.ctxBar }, segs),
        legend ? h("div", { key: "leg", style: STYLES.ctxLegend }, legend) : null,
      ]);
    }

    _renderSessions() {
      const h = React.createElement;
      const S = STYLES;
      const savedIds = new Set(this.state.sessions.map((s) => s.sessionId));
      const target = this.state.renameTarget;
      const canSave = !!(this.state.sessionOn || target);

      // Save / rename bar
      const placeholder = target ? "new name… (Enter to save)" : this.state.sessionOn
        ? "name this session…" : "turn session on to save the current one";
      const bar = h("div", { key: "save", style: S.sessSaveRow }, [
        h("input", {
          key: "in",
          style: S.sessInput,
          placeholder,
          value: this.state.saveName,
          disabled: !canSave,
          ref: (el) => { if (el && target) el.focus(); },
          onChange: (e) => this.setState({ saveName: e.target.value }),
          onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); this.onSaveSession(); } if (e.key === "Escape") this.setState({ renameTarget: null, saveName: "" }); },
        }),
        h("button", { key: "b", style: S.sessSaveBtn, onClick: this.onSaveSession, disabled: !canSave }, target ? "rename" : "save"),
      ]);

      const savedRows = this.state.sessions.map((s) =>
        h("div", { key: s.sessionId, style: S.sessRow }, [
          h("button", { key: "n", style: S.sessName, title: "Resume", onClick: () => this._resumeSession(s.sessionId) }, "↩ " + s.name),
          h("button", { key: "e", style: S.sessDel, title: "Rename", onClick: () => this._startRename(s.sessionId, s.name) }, "✎"),
          h("button", { key: "x", style: S.sessDel, title: "Remove bookmark", onClick: () => this._deleteSession(s.sessionId) }, "×"),
        ]),
      );

      const recent = this.state.recentSessions.filter((s) => !savedIds.has(s.sessionId));
      const recentRows = recent.map((s) =>
        h("div", { key: s.sessionId, style: S.sessRow }, [
          h("button", { key: "n", style: S.sessName, title: "Resume", onClick: () => this._resumeSession(s.sessionId) }, "↩ " + s.label),
          h("button", { key: "s", style: S.sessDel, title: "Name / save", onClick: () => this._startRename(s.sessionId, "") }, "+"),
        ]),
      );

      const groups = [bar];
      if (savedRows.length) {
        groups.push(h("div", { key: "sh", style: S.sessGroup }, "saved"), ...savedRows);
      }
      if (recentRows.length) {
        groups.push(h("div", { key: "rh", style: S.sessGroup }, "recent"), ...recentRows);
      }
      if (!savedRows.length && !recentRows.length) {
        groups.push(h("div", { key: "empty", style: S.sessEmpty }, "No sessions yet."));
      }
      return h("div", { key: "sessions", style: S.sessMenu }, groups);
    }

    _renderSlashMenu() {
      const h = React.createElement;
      const matches = this._slashMatches();
      if (!matches.length) return null;
      const sel = Math.min(this.state.slashSel, matches.length - 1);
      return h("div", { key: "slash", style: STYLES.slashMenu }, [
        h("div", { key: "hdr", style: STYLES.slashHdr }, "↑↓ select · ⏎ run · esc dismiss"),
        ...matches.map((c, i) =>
          h("div", {
            key: c,
            style: Object.assign({}, STYLES.slashItem, i === sel ? STYLES.slashItemSel : null),
            onMouseEnter: () => this.setState({ slashSel: i }),
            onClick: () => this._pickSlash(c),
          }, "/" + c),
        ),
      ]);
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
        if (m.role === "tool") {
          return h("div", { key: i, style: S.toolMsg }, "🔧 " + m.text);
        }
        if (m.role === "note") {
          return h("div", { key: i, style: S.noteMsg }, m.text);
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
      const toolsBtnStyle = Object.assign(
        {},
        S.clearBtn,
        this.state.toolsOn ? S.toolsBtnOn : null,
      );
      const sessionBtnStyle = Object.assign(
        {},
        S.clearBtn,
        this.state.sessionOn ? S.sessionBtnOn : null,
      );
      return h("div", { style: Object.assign({}, S.panel, { width: this.state.width }) }, [
        h("div", {
          key: "drag",
          style: S.dragHandle,
          onMouseDown: this.onDragStart,
          title: "Drag to resize",
        }),
        h("div", { key: "hd", style: S.header }, [
          h("span", { key: "t" }, "◇ copilot"),
          h("span", { key: "btns" }, [
            h("button", { key: "se", style: sessionBtnStyle, onClick: this.onToggleSession, title: "Session mode: a running conversation window (auto-compacts when full)" },
              this.state.sessionOn ? "∞ session" : "session"),
            h("button", { key: "sv", style: Object.assign({ marginLeft: 6 }, S.clearBtn), onClick: this.onToggleSessions, title: "Save / recall sessions" }, "▾"),
            h("button", { key: "tl", style: Object.assign({ marginLeft: 6 }, toolsBtnStyle), onClick: this.onToggleTools, title: "Workspace tools: let Claude read files / run commands (with approval)" },
              this.state.toolsOn ? "⚒ tools" : "tools"),
            h("button", { key: "w", style: Object.assign({ marginLeft: 6 }, watchBtnStyle), onClick: this.onToggleWatch, title: "Watch mode: auto-summarize new activity" },
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
        this.state.sessionOn && this.state.ctx ? this._renderMeter() : null,
        this.state.watchOn && this.state.watchText
          ? h("div", { key: "wb", style: S.watchBanner }, "👁  " + this.state.watchText)
          : null,
        this.state.showSessions ? this._renderSessions() : null,
        h("div", { key: "ms", style: S.messages, ref: (el) => (this._msgEl = el) }, rows),
        this.state.perm
          ? h("div", { key: "perm", style: S.permCard }, [
              h("div", { key: "q", style: S.permTitle }, "Allow " + this.state.perm.name + "?"),
              h("div", { key: "d", style: S.permDetail }, this.state.perm.detail || ""),
              h("div", { key: "btns", style: S.permBtns }, [
                h("button", { key: "1", style: S.permAllow, onClick: () => this.respondPerm("allow", "once") }, "Allow once"),
                h("button", { key: "2", style: S.permAllow, onClick: () => this.respondPerm("allow", "session") }, "Allow for session"),
                h("button", { key: "3", style: S.permDeny, onClick: () => this.respondPerm("deny") }, "Deny"),
              ]),
            ])
          : null,
        this._renderSlashMenu(),
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
  dragHandle: {
    position: "absolute",
    left: -3,
    top: 0,
    bottom: 0,
    width: 6,
    cursor: "col-resize",
    zIndex: 200,
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
  toolsBtnOn: { color: "#e6b673", borderColor: "#6f5320", background: "#26200f" },
  sessionBtnOn: { color: "#8ab4f8", borderColor: "#2b4a6f", background: "#0f1a26" },
  noteMsg: { margin: "8px 0", textAlign: "center", fontSize: 11, color: "#7e8796", fontStyle: "italic" },
  sessMenu: {
    margin: "0 12px 8px",
    background: "#0b0e14",
    border: "1px solid #2a2f3a",
    borderRadius: 6,
    maxHeight: 260,
    overflowY: "auto",
  },
  sessSaveRow: { display: "flex", gap: 6, padding: 8, borderBottom: "1px solid #1c2230" },
  sessInput: {
    flex: 1,
    background: "#10131a",
    color: "#e7ecf5",
    border: "1px solid #2a2f3a",
    borderRadius: 5,
    padding: "3px 7px",
    fontSize: 11.5,
  },
  sessSaveBtn: {
    background: "#1c2940",
    color: "#8ab4f8",
    border: "1px solid #2b4a6f",
    borderRadius: 5,
    fontSize: 11,
    padding: "0 10px",
    cursor: "pointer",
  },
  sessRow: { display: "flex", alignItems: "center", borderBottom: "1px solid #12151c" },
  sessName: {
    flex: 1,
    textAlign: "left",
    background: "transparent",
    color: "#cdd3de",
    border: 0,
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  sessDel: {
    background: "transparent",
    color: "#7e8796",
    border: 0,
    padding: "6px 10px",
    fontSize: 13,
    cursor: "pointer",
  },
  sessEmpty: { padding: "8px 10px", fontSize: 11, color: "#5f6878" },
  sessGroup: { padding: "5px 10px 2px", fontSize: 9.5, color: "#5f6878", textTransform: "uppercase", letterSpacing: 1 },
  ctxWrap: { padding: "0 12px 8px" },
  ctxLabel: { fontSize: 10, color: "#7e8796", marginBottom: 3 },
  ctxBar: { height: 5, display: "flex", background: "#1c2230", borderRadius: 3, overflow: "hidden" },
  ctxLegend: { fontSize: 9.5, color: "#5f6878", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  slashMenu: {
    margin: "0 8px 6px",
    background: "#0b0e14",
    border: "1px solid #2a2f3a",
    borderRadius: 6,
    maxHeight: 220,
    overflowY: "auto",
    boxShadow: "0 -4px 16px rgba(0,0,0,0.4)",
  },
  slashHdr: {
    padding: "5px 10px",
    fontSize: 9.5,
    color: "#5f6878",
    borderBottom: "1px solid #1c2230",
  },
  slashItem: {
    padding: "5px 10px",
    fontSize: 12,
    color: "#cdd3de",
    cursor: "pointer",
    fontFamily: "Menlo, monospace",
  },
  slashItemSel: { background: "#1c2940", color: "#8ab4f8" },
  permCard: {
    margin: "0 12px 8px",
    padding: "8px 10px",
    background: "#1b1605",
    border: "1px solid #6f5320",
    borderRadius: 6,
  },
  permTitle: { color: "#e6b673", fontWeight: 600, marginBottom: 4 },
  permDetail: {
    fontFamily: "Menlo, monospace",
    fontSize: 11,
    color: "#cdd3de",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    marginBottom: 8,
  },
  permBtns: { display: "flex", gap: 6, flexWrap: "wrap" },
  permAllow: {
    background: "#1c3326",
    color: "#7ee0a1",
    border: "1px solid #2e6f4a",
    borderRadius: 5,
    fontSize: 11,
    padding: "3px 9px",
    cursor: "pointer",
  },
  permDeny: {
    background: "#33191c",
    color: "#e08a8a",
    border: "1px solid #6f2e2e",
    borderRadius: 5,
    fontSize: 11,
    padding: "3px 9px",
    cursor: "pointer",
  },
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
  toolMsg: {
    margin: "3px 0",
    padding: "3px 8px",
    fontFamily: "Menlo, monospace",
    fontSize: 11,
    color: "#8a93a6",
    background: "#0e1219",
    borderLeft: "2px solid #2e6f4a",
    borderRadius: 3,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
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
