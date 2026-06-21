// LiveSession — a long-lived streaming-input query to the Agent SDK.
//
// This is the "running context window": one query() kept alive via an async
// input iterable. The conversation accumulates inside it (the SDK auto-compacts
// when it fills, preserving CLAUDE.md), and because the query stays open we can
// call getContextUsage() between turns for the segmented context meter and read
// the available slash commands from the init message.
//
// Used only in session mode. Quick (stateless) mode keeps the per-message
// query() in claude.js.

import { query } from "@anthropic-ai/claude-agent-sdk";

export class LiveSession {
  constructor(options, handlers = {}) {
    this.options = options;
    this.h = handlers; // { onChunk, onTool, onResult, onContext, onSlash, onRate, onError }
    this._queue = [];
    this._waiters = [];
    this._closed = false;
    this._sawDelta = false;
    this.q = null;
    this.started = false;
  }

  // The open-ended input the SDK consumes; yields queued user turns and parks
  // when empty, keeping the session alive until stop().
  async *_input() {
    while (!this._closed) {
      if (this._queue.length) {
        yield this._queue.shift();
      } else {
        await new Promise((res) => this._waiters.push(res));
      }
    }
  }

  _wake() {
    const w = this._waiters.shift();
    if (w) w();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.q = query({ prompt: this._input(), options: this.options });
    this._pump().catch((e) => this.h.onError?.(e));
  }

  // Send a user turn (plain text, or a "/command" the CLI will execute).
  send(text) {
    this._queue.push({ type: "user", message: { role: "user", content: text } });
    this._wake();
  }

  stop() {
    this._closed = true;
    this._wake();
  }

  async _pump() {
    for await (const msg of this.q) {
      if (msg.type === "system" && msg.subtype === "init") {
        if (Array.isArray(msg.slash_commands)) this.h.onSlash?.(msg.slash_commands);
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          this._sawDelta = true;
          this.h.onChunk?.(ev.delta.text);
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message?.content || []) {
          if (block.type === "text" && !this._sawDelta) {
            this.h.onChunk?.(block.text);
          } else if (block.type === "tool_use") {
            this.h.onTool?.({ name: block.name, input: block.input || {} });
          }
        }
      } else if (msg.type === "rate_limit_event") {
        if (msg.rate_limit_info?.status === "rejected") this.h.onRate?.(msg.rate_limit_info);
      } else if (msg.type === "result") {
        this._sawDelta = false;
        this.h.onResult?.(msg);
        // Read the segmented context window for the meter.
        try {
          const cu = await this.q.getContextUsage();
          this.h.onContext?.(cu);
        } catch {
          /* not fatal — meter just won't update this turn */
        }
      }
    }
  }
}
