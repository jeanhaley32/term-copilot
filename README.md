# term-copilot

A terminal copilot: a chat side panel in your terminal where a **local Claude
Code instance** (your subscription, not the API) watches what you're doing in
the shell and responds on demand.

```
┌─ Hyper ───────────────────────────┬─ copilot ────────┐
│ $ npm run build                   │ ◇ copilot         │
│ ... error TS2345 ...              │ ● 12% of window   │
│ $                                 │                   │
│                                   │ > why did it fail?│
│                                   │ tsc found a type… │
└───────────────────────────────────┴──────────────────┘
        terminal output ──socket──▶ bridge ──▶ Claude
```

## Architecture

Three processes over one Unix socket (`~/.term-copilot.sock`), NDJSON framed:

| Piece | Role |
|---|---|
| **Hyper plugin** (`hyper-plugin/`) | Taps terminal output + cwd → bridge; renders the chat panel |
| **bridge** (`bridge/`) | Rolling output buffer, project-memory context, RateGuard, calls Claude |
| **Claude** | Your logged-in local Claude Code, via the Agent SDK |

**Terminal output goes to the bridge, never straight to the model.** Claude is
invoked only when you send a message, with the recent buffer as context. This
keeps us within subscription rate limits.

### Key design points
- **Subscription auth:** the Agent SDK spawns your `claude` binary. With no
  `ANTHROPIC_API_KEY` set and a Pro/Max login, it bills the subscription.
- **Project memory:** the bridge resolves `CLAUDE.md` / `.claude/rules` from the
  *terminal's* cwd (reported by the plugin), exactly like Claude Code.
- **RateGuard:** a 3-state circuit breaker. On a rate-limit it fails fast and
  waits the server's `resetsAt` (else exponential backoff with jitter); one
  half-open probe closes it. Bucket-aware (`five_hour` vs `seven_day*`).

## Run

```bash
npm install            # installs the Agent SDK
npm run bridge         # start the bridge (keep running)
npm run demo "why did my build fail?"   # dummy client — no UI needed
```

Make sure you're logged in with your subscription and have **no** API key set:
```bash
echo $ANTHROPIC_API_KEY   # should be empty
claude   # log in once if needed
```

## Install the Hyper plugin

1. Install [Hyper](https://hyper.is).
2. Link the plugin into Hyper's local-plugin dir:
   ```bash
   mkdir -p ~/.hyper_plugins/local
   ln -s ~/term-copilot/hyper-plugin ~/.hyper_plugins/local/hyper-term-copilot
   ```
3. In `~/.hyper.js`, add it to `localPlugins`:
   ```js
   localPlugins: ["hyper-term-copilot"],
   ```
4. Start the bridge (`npm run bridge`), then launch Hyper. The copilot panel
   appears on the right.

## Protocol

NDJSON over the socket (see `bridge/protocol.js`):

- client → bridge: `term_data` · `cwd` · `chat_msg`
- bridge → client: `chat_stream` · `chat_done` · `chat_error` · `rate_limited`
  · `rate_status` · `status`
