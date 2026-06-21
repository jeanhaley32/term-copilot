// The "brain": invokes the local Claude Code instance via the Agent SDK.
//
// Subscription auth: the SDK spawns the `claude` binary, which uses whatever
// that binary is logged in with. As long as ANTHROPIC_API_KEY is NOT set and
// you're logged in via your Pro/Max subscription, this bills the subscription,
// not the API. We point the SDK at your installed CLI to be certain it's the
// same authenticated binary.

import { query } from "@anthropic-ai/claude-agent-sdk";

// Thrown when the subscription rate limit rejects the request. Carries the
// bucket that tripped and when it resets, so the circuit breaker can wait the
// authoritative amount of time instead of guessing.
export class RateLimitError extends Error {
  constructor({ rateLimitType, resetsAt, errorCode } = {}) {
    super(`rate limited${rateLimitType ? ` (${rateLimitType})` : ""}`);
    this.name = "RateLimitError";
    this.rateLimitType = rateLimitType || null;
    this.resetsAt = normalizeEpochMs(resetsAt); // ms, or null
    this.errorCode = errorCode || null;
  }
}

// SDK timestamps may be epoch seconds or ms; normalize to ms.
function normalizeEpochMs(t) {
  if (typeof t !== "number" || !isFinite(t)) return null;
  return t < 1e12 ? t * 1000 : t;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;

const COPILOT_PROMPT = `You are a terminal copilot. The user is working in a shell and you sit in a
chat side panel beside it. You are given a snapshot of their RECENT terminal
output as context, followed by their message.

Be concise and practical. Explain what you see, diagnose errors, and suggest the
next command or fix. Use short paragraphs and inline code. Do NOT run commands
yourself — you are advising, not acting. If the terminal context is empty or
irrelevant to the question, just answer the question directly.`;

// Guard against API billing — fail loud rather than silently spending money.
if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "[claude] WARNING: ANTHROPIC_API_KEY is set — this will bill the API, " +
      "not your subscription. Unset it to use subscription auth.",
  );
}

// Cap on how much terminal output we inject, in characters. The terminal
// buffer is the most disposable context layer, so we trim it first to leave
// headroom for CLAUDE.md / rules / auto-memory that the SDK loads on top.
const MAX_TERMINAL_CHARS = 12000;

// Ask Claude about the given terminal context + user message.
//
// `cwd` is the TERMINAL's current working directory (reported by the client),
// NOT the bridge's. The SDK resolves CLAUDE.md / .claude/rules by walking up
// from this directory, so the copilot sees the same project memory Claude Code
// would in that directory. With settingSources omitted the SDK already loads
// ["user","project","local"]; we set it explicitly to make the intent obvious.
//
// `onChunk(text)` is called with incremental text as it streams.
// Resolves with the full reply text.
// Cap on how much prior-conversation transcript we replay for continuity.
const MAX_HISTORY_CHARS = 6000;

// A small, harness-injected context block telling Claude what this interaction
// actually is: who it's running as, that it sees only a rolling snapshot, the
// live environment, and whether this is an interactive question or an automatic
// watch tick. Kept short on purpose — it's orientation, not instructions.
function harnessContext({ cwd, shell, os, mode } = {}) {
  const env = [os && `os ${os}`, shell && `shell ${shell}`, cwd && `cwd ${cwd}`]
    .filter(Boolean)
    .join(" · ");
  const situation =
    mode === "watch"
      ? "This is an AUTOMATIC watch-mode check (the user did not ask a question). " +
        "Only speak up if there is genuinely noteworthy NEW activity; otherwise reply (nothing)."
      : "This is an interactive question the user typed in the side panel.";
  return (
    "<harness_context>\n" +
    "You are term-copilot, embedded beside the user's live shell. You are shown a " +
    "ROLLING SNAPSHOT of recent terminal output (not the full session) and reply in a " +
    "narrow side panel — keep replies concise and skimmable. " +
    situation +
    (env ? `\nEnvironment: ${env}.` : "") +
    "\n</harness_context>\n\n"
  );
}

export async function ask({
  terminalContext,
  userMessage,
  cwd,
  history,
  meta,
  tools, // { enabled, allowedTools, canUseTool, onTool } or null
  onChunk,
}) {
  // Trim the terminal buffer to its tail so a large CLAUDE.md still fits.
  let term = terminalContext || "";
  if (term.length > MAX_TERMINAL_CHARS) {
    term = "…(truncated)…\n" + term.slice(term.length - MAX_TERMINAL_CHARS);
  }

  // Replay recent chat turns so follow-ups have context. Trim from the front
  // (oldest) to a char budget so the window stays bounded.
  let transcript = "";
  if (Array.isArray(history) && history.length) {
    const turns = history.map(
      (t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`,
    );
    transcript = turns.join("\n");
    if (transcript.length > MAX_HISTORY_CHARS) {
      transcript = "…(earlier turns trimmed)…\n" +
        transcript.slice(transcript.length - MAX_HISTORY_CHARS);
    }
    transcript = `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\n`;
  }

  const prompt =
    harnessContext({ cwd, shell: meta?.shell, os: meta?.os, mode: meta?.mode }) +
    `<recent_terminal_output>\n${term || "(empty)"}\n</recent_terminal_output>\n\n` +
    transcript +
    `User: ${userMessage}`;

  let full = "";
  let sawDelta = false;
  let rateInfo = null; // latest SDKRateLimitInfo seen
  let usage = null; // token usage from the result
  let rateLimits = null; // per-bucket utilization/resets from the result

  const useTools = !!(tools && tools.enabled);
  const options = {
    systemPrompt: COPILOT_PROMPT,
    allowedTools: useTools ? tools.allowedTools : [],
    // Tool use needs room to loop (read files, run a command, then answer).
    maxTurns: useTools ? 16 : 1,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    // Resolve project memory + run tools from the terminal's directory.
    cwd: cwd || process.cwd(),
    settingSources: ["user", "project", "local"],
  };
  if (useTools) {
    options.permissionMode = "default";
    options.canUseTool = tools.canUseTool;
  }

  const q = query({ prompt, options });

  for await (const msg of q) {
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        sawDelta = true;
        full += ev.delta.text;
        onChunk?.(ev.delta.text);
      }
    } else if (msg.type === "assistant") {
      for (const block of msg.message?.content || []) {
        if (block.type === "text" && !sawDelta) {
          // Fallback if partial streaming wasn't emitted: take the final text.
          full += block.text;
          onChunk?.(block.text);
        } else if (block.type === "tool_use") {
          tools?.onTool?.({ name: block.name, input: block.input || {} });
        }
      }
    } else if (msg.type === "rate_limit_event") {
      rateInfo = msg.rate_limit_info || rateInfo;
    } else if (msg.type === "result") {
      usage = msg.usage || usage;
      rateLimits = msg.rate_limits || rateLimits;
      if (msg.subtype !== "success") {
        // If a rate limit caused this, throw the typed error so the breaker
        // can react; otherwise surface a generic failure.
        if (rateInfo?.status === "rejected" || rateInfo?.errorCode) {
          throw new RateLimitError(rateInfo);
        }
        throw new Error(`Claude returned: ${msg.subtype || "error"}`);
      }
    }
  }

  // Even on success the SDK can signal a hard rejection via rate_limit_event.
  if (rateInfo?.status === "rejected" || rateInfo?.errorCode) {
    throw new RateLimitError(rateInfo);
  }

  return { text: full, usage, rateLimits, rateInfo };
}
