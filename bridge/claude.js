// The "brain": invokes the local Claude Code instance via the Agent SDK.
//
// Subscription auth: the SDK spawns the `claude` binary, which uses whatever
// that binary is logged in with. As long as ANTHROPIC_API_KEY is NOT set and
// you're logged in via your Pro/Max subscription, this bills the subscription,
// not the API. We point the SDK at your installed CLI to be certain it's the
// same authenticated binary.

import { query } from "@anthropic-ai/claude-agent-sdk";

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

// Ask Claude about the given terminal context + user message.
// `onChunk(text)` is called with incremental text as it streams.
// Resolves with the full reply text.
export async function ask({ terminalContext, userMessage, onChunk }) {
  const prompt =
    `<recent_terminal_output>\n${terminalContext || "(empty)"}\n</recent_terminal_output>\n\n` +
    `User: ${userMessage}`;

  let full = "";
  let sawDelta = false;

  const q = query({
    prompt,
    options: {
      systemPrompt: COPILOT_PROMPT,
      allowedTools: [],
      maxTurns: 1,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: CLAUDE_BIN,
    },
  });

  for await (const msg of q) {
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        sawDelta = true;
        full += ev.delta.text;
        onChunk?.(ev.delta.text);
      }
    } else if (msg.type === "assistant" && !sawDelta) {
      // Fallback if partial streaming wasn't emitted: take the final text.
      for (const block of msg.message?.content || []) {
        if (block.type === "text") {
          full += block.text;
          onChunk?.(block.text);
        }
      }
    } else if (msg.type === "result" && msg.subtype !== "success") {
      throw new Error(`Claude returned: ${msg.subtype || "error"}`);
    }
  }

  return full;
}
