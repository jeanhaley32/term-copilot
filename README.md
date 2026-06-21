# term-copilot

A terminal copilot: a chat side panel in your terminal where a **local Claude
Code instance** watches what you're doing in the shell and responds — on your
**subscription**, not the pay-per-token API.

```
┌─ Hyper ───────────────────────────┬─ ◇ copilot ───────────┐
│ $ npm run build                   │ ● 12% of window       │
│ ... error TS2345 ...              │                       │
│ $                                 │ > why did it fail?    │
│                                   │ tsc found a type      │
│                                   │ mismatch on line 89…  │
│                                   │   ┌──────────────┐    │
│                                   │   │ git restore… │→ins│
│                                   │   └──────────────┘    │
└───────────────────────────────────┴───────────────────────┘
        terminal output ──socket──▶ bridge ──▶ Claude
```

## Features

- **Context-aware chat** — Claude sees a rolling snapshot of your recent terminal
  output and answers questions about it (errors, commands, what just happened).
- **Subscription auth** — rides on your existing Claude Code login; no API key,
  no extra billing, no separate sign-in.
- **Project memory** — loads `CLAUDE.md` / `.claude/rules` from your terminal's
  current directory, exactly like Claude Code.
- **Conversation memory** — follow-up questions remember the prior turns.
- **Markdown rendering** — replies render with code blocks, bold, lists.
- **Insert code into the terminal** — a `→ insert` button on any code block
  drops the snippet at your prompt (bracketed-paste, so it doesn't auto-run).
- **Watch mode** — opt-in live updates that summarize new activity, with
  guardrails so an idle terminal costs nothing.
- **Rate-limit resilient** — a circuit breaker that respects the server's reset
  time and backs off, so you never hang or spam a limit.

## How it works

Three processes over one Unix socket (`~/.term-copilot.sock`), NDJSON-framed:

| Piece | Role |
|---|---|
| **Hyper plugin** (`hyper-plugin/`) | Taps terminal output + cwd → bridge; renders the chat panel; inserts code |
| **bridge** (`bridge/`) | Rolling output buffer, project-memory context, RateGuard, calls Claude |
| **Claude** | Your logged-in local Claude Code, via the Agent SDK |

**Terminal output goes to the bridge, never straight to the model.** Claude is
invoked only when you send a message (or on a guarded watch tick), with the
recent buffer as context — that's what keeps it within subscription limits.

Design details:

- **Subscription auth** — the Agent SDK spawns your `claude` binary, inheriting
  its login. With no `ANTHROPIC_API_KEY` set and a Pro/Max login, it bills the
  subscription.
- **Harness context** — every call is prefixed with a small block telling Claude
  who it is, that it sees a rolling snapshot, the environment (os/shell/cwd), and
  whether this is a question or an automatic watch tick.
- **RateGuard** — a 3-state circuit breaker. On a rate-limit it fails fast and
  waits the server's `resetsAt` (else exponential backoff with jitter); one
  half-open probe closes it. Bucket-aware (`five_hour` vs `seven_day*`).

## Requirements

- macOS, [Node.js](https://nodejs.org) 18+, and [Hyper](https://hyper.is)
- [Claude Code](https://claude.com/claude-code) installed and **logged in with a
  Pro/Max subscription** (`claude` → `/login`)
- `ANTHROPIC_API_KEY` **unset** (otherwise the SDK bills the API)

## Install (one-time)

```bash
git clone https://github.com/jeanhaley32/term-copilot.git ~/term-copilot
cd ~/term-copilot && npm install

# link the Hyper plugin
mkdir -p ~/.hyper_plugins/local
ln -s ~/term-copilot/hyper-plugin ~/.hyper_plugins/local/hyper-term-copilot
```

Then add the plugin to `~/.hyper.js`:

```js
localPlugins: ["hyper-term-copilot"],
```

## Run

```bash
cd ~/term-copilot
npm run bridge      # start the bridge — keep this running
open -a Hyper       # the copilot panel appears on the right
```

The bridge must stay running while you use the panel; if it stops, the panel
shows `● offline` and reconnects automatically when you start it again.

Try it without any UI:

```bash
npm run demo "why did my build fail?"
```

## Signing in

There is **no separate login for term-copilot** — it uses your Claude Code
session. Manage it through Claude Code itself:

```bash
claude            # launch
/login            # sign in (subscription OAuth)
/status           # see the active account
/logout           # sign out
```

The token lives in your macOS Keychain (+ `~/.claude.json`). The bridge prints a
warning on startup if `ANTHROPIC_API_KEY` is set, since that would bill the API.

## Using the panel

- **Ask** — type in the box, Enter to send (Shift+Enter for a newline).
- **⌘⇧L** — "look at this": ask about whatever's on screen right now.
- **→ insert** — on a code block, drops the snippet at your shell prompt.
- **watch** — toggle live updates; the dropdown sets the cadence (10s/30s/60s).
- **clear** — reset the conversation.

### Watch mode

Live updates that summarize new terminal activity, kept frugal:

- **Change-gated** — a tick only spends a request if the buffer changed; idle
  terminal = zero requests.
- **Circuit-aware** — skips silently while RateGuard is open.
- **Floored interval** — minimum 10s; stateless prompt, shown in a banner.

It still spends requests on a timer when output is flowing — leave it off for
normal use and flip it on for a long-running task you want watched.

## Protocol

NDJSON over the socket (see `bridge/protocol.js`):

- client → bridge: `term_data` · `cwd` · `chat_msg` · `clear` · `watch`
- bridge → client: `chat_stream` · `chat_done` · `chat_error` · `rate_limited`
  · `rate_status` · `watch_update` · `watch_state` · `status`

## Project layout

```
bridge/        socket server, rolling buffer, RateGuard, Claude (Agent SDK)
client/        dummy.js — headless test client
hyper-plugin/  Hyper plugin: output/cwd tap, chat panel, code insert, markdown
```

## Roadmap

- Per-session buffers/history (currently one shared session)
- A `/status`-style account indicator in the panel
- Ports to other terminals (the bridge is terminal-agnostic)

## Notes

Inserted commands deliberately land at the prompt for review and are **not**
auto-run. Watch mode and chat both draw on your shared subscription pool — the
guardrails minimize that, but heavy use can still approach plan limits.
