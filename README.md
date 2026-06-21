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

## Quick start

```bash
# 1. clone + install
git clone https://github.com/jeanhaley32/term-copilot.git ~/term-copilot
cd ~/term-copilot && npm install

# 2. link the Hyper plugin
mkdir -p ~/.hyper_plugins/local
ln -s ~/term-copilot/hyper-plugin ~/.hyper_plugins/local/hyper-term-copilot
#    then add  localPlugins: ["hyper-term-copilot"]  to ~/.hyper.js

# 3. make sure Claude Code is logged in (subscription, no API key)
claude          # /login if needed,  /status to check
echo $ANTHROPIC_API_KEY   # should print nothing

# 4. run
npm run bridge  # keep this running
open -a Hyper   # copilot panel appears on the right
```

See [Install](#install-one-time), [Run](#run), and [Troubleshooting](#troubleshooting)
below for detail.

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
- **Workspace tools** — opt-in Claude-Code-style harness: Claude can read files,
  grep, and run commands in your terminal's directory. Read-only is auto-allowed;
  mutating actions (Bash/Edit/Write) require approval, with a per-session
  allow-list so you don't re-approve the same action.
- **Session mode** — opt-in running conversation window (like Claude Code): a
  persistent streaming SDK session so context accumulates, with the SDK's
  built-in auto-compaction when it fills (CLAUDE.md preserved). A **segmented
  context meter** (system / tools / messages / free) shows how full the window
  is. Off by default (stateless Q&A is cheaper).
- **Slash commands** — in session mode, type `/` to autocomplete the SDK's
  commands (`/compact`, `/context`, `/clear`, `/usage`, …); they execute in the
  live session.
- **Terminal paging** — a `read_terminal` tool lets the model page into a large
  scrollback on demand, so prompts inject only a small slice instead of dumping
  everything.
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
- **session** — toggle the running context window (see below); a meter shows fill.
- **tools** — toggle the workspace harness (see below).
- **watch** — toggle live updates; the dropdown sets the cadence (10s/30s/60s).
- **clear** — reset the conversation.

### Session mode (running context window)

By default each message is a fresh, bounded query (cheap, no growing window).
Toggle **session** to instead keep one **persistent conversation** that
accumulates context across turns — like Claude Code:

- Continuity: it remembers earlier turns without us replaying a transcript.
- The SDK **auto-compacts** the conversation when the window fills, preserving
  CLAUDE.md — you don't manage it.
- A meter shows context fill (turns amber past 80%, near a compaction).

Best for long, building conversations (debugging a thread, a learning session).
It re-sends accumulated context each turn, so it costs more than stateless
Q&A — leave it off for quick one-offs.

### Workspace tools

Toggle **tools** to let Claude actually act in your terminal's directory, not
just observe it:

- **Read-only** (`Read`, `Grep`, `Glob`, `LS`) — auto-allowed, no prompts.
- **Mutating** (`Bash`, `Edit`, `Write`) — each action prompts in the panel with
  **Allow once / Allow for session / Deny**. "Allow for session" whitelists that
  specific action (e.g. the exact command) so it won't re-ask.
- Tool activity is shown inline (`🔧 Bash · npm test`) as Claude works.
- Toggling tools off clears the session allow-list.

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

- client → bridge: `term_data` · `cwd` · `chat_msg` · `clear` · `watch` ·
  `tools` · `permission_response`
- bridge → client: `chat_stream` · `chat_done` · `chat_error` · `rate_limited` ·
  `rate_status` · `watch_update` · `watch_state` · `tool_use` ·
  `permission_request` · `tools_state` · `status`

## Project layout

```
bridge/        socket server, rolling buffer, RateGuard, Claude (Agent SDK)
client/        dummy.js — headless test client
hyper-plugin/  Hyper plugin: output/cwd tap, chat panel, code insert, markdown
```

## Configuration

Environment variables read by the bridge (and the plugin's client):

| Variable | Default | Effect |
|---|---|---|
| `TERM_COPILOT_SOCK` | `~/.term-copilot.sock` | Socket path. Set the same value for the bridge and Hyper if you change it. |
| `CLAUDE_BIN` | `~/.local/bin/claude` | Path to the `claude` binary the Agent SDK spawns. Set if yours is elsewhere (`which claude`). |
| `ANTHROPIC_API_KEY` | _(unset)_ | If set, the SDK bills the **API** instead of your subscription. Leave unset. |

In-app knobs (no restart needed): the **tools** toggle, **watch** toggle +
interval dropdown, and **clear** — all in the panel header.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel says `● offline` | The bridge isn't running. `cd ~/term-copilot && npm run bridge`. It reconnects automatically. |
| No panel in Hyper | Check `localPlugins: ["hyper-term-copilot"]` in `~/.hyper.js` and the symlink in `~/.hyper_plugins/local/`. Fully quit + reopen Hyper (⌘Q). |
| Replies error with auth/billing | Run `claude` → `/status` to confirm you're logged in; ensure `ANTHROPIC_API_KEY` is unset. |
| `● rate-limited … back HH:MM` | You hit a subscription limit; the breaker waits until reset. Turn **watch** off or lengthen its interval. |
| Plugin code changes not applied | Hyper caches plugins — fully quit (⌘Q) and reopen, don't just close the window. |
| Tools never prompt for Bash/Edit | Make sure the **tools** toggle is on (amber `⚒ tools`). Read-only tools never prompt by design. |

Bridge logs go to its terminal (or wherever you redirect it). It logs each
`chat_msg`, `chat_done`, `cwd ->`, `watch`/`tools` toggle, and rate-limit event.

## Uninstall

```bash
rm ~/.hyper_plugins/local/hyper-term-copilot      # unlink the plugin
# remove "hyper-term-copilot" from localPlugins in ~/.hyper.js
rm -rf ~/term-copilot                              # remove the project
rm -f ~/.term-copilot.sock                         # stale socket, if any
```

## Roadmap

- Per-session buffers/history (currently one shared session)
- A `/status`-style account indicator in the panel
- Ports to other terminals (the bridge is terminal-agnostic)

## Notes

Inserted commands deliberately land at the prompt for review and are **not**
auto-run. Watch mode and chat both draw on your shared subscription pool — the
guardrails minimize that, but heavy use can still approach plan limits.
