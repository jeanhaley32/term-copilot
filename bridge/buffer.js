// A rolling buffer of recent terminal output. We keep the tail (most recent
// bytes) so Claude is only ever handed *recent* context on demand — we never
// stream the whole session to the model. This is what keeps the design within
// subscription rate limits.

export class RollingBuffer {
  constructor(maxChars = 16000) {
    this.maxChars = maxChars;
    this.text = "";
  }

  append(chunk) {
    this.text += chunk;
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(this.text.length - this.maxChars);
    }
  }

  // Most recent `chars` of output (defaults to the whole buffer).
  tail(chars = this.maxChars) {
    return this.text.slice(Math.max(0, this.text.length - chars));
  }

  clear() {
    this.text = "";
  }
}
