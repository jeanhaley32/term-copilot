// RateGuard — a circuit breaker around the Claude call.
//
// Subscription usage is a shared pool (claude.ai + Desktop + Code), and the
// limit numbers are unpublished and token-based. So we don't budget against a
// number — we react to the SDK's own signals:
//   - rate_limit_event.status: 'allowed' | 'allowed_warning' | 'rejected'
//   - rateLimitType: which bucket (five_hour | seven_day | seven_day_opus | ...)
//   - resetsAt: the authoritative time the bucket refills
//
// Three states:
//   CLOSED     normal — calls pass through.
//   OPEN       a limit was hit — calls are rejected INSTANTLY (no hanging)
//              until the wait elapses. Wait = the server's resetsAt when known,
//              else exponential backoff with jitter (the "standoff that
//              increments over time").
//   HALF_OPEN  wait elapsed — let exactly ONE probe through. Success -> CLOSED
//              (and reset the backoff). Failure -> OPEN again, longer wait.

import { RateLimitError } from "./claude.js";

export class CircuitOpenError extends Error {
  constructor(retryAtMs, rateLimitType) {
    const when = new Date(retryAtMs);
    super(
      `rate-limited${rateLimitType ? ` (${rateLimitType})` : ""} — retry after ` +
        when.toLocaleTimeString(),
    );
    this.name = "CircuitOpenError";
    this.retryAtMs = retryAtMs;
    this.rateLimitType = rateLimitType || null;
  }
}

const STATES = { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" };

export class RateGuard {
  constructor({
    baseMs = 2000, // first backoff step
    factor = 2, // doubles each consecutive failure
    maxBackoffMs = 5 * 60 * 1000, // cap when the server gives us no resetsAt
    jitter = 0.2, // ±20% randomization
    now = () => Date.now(),
  } = {}) {
    this.cfg = { baseMs, factor, maxBackoffMs, jitter };
    this.now = now;
    this.state = STATES.CLOSED;
    this.openUntil = 0; // ms epoch
    this.attempt = 0; // consecutive failures, for backoff
    this.probing = false; // a half-open probe is in flight
    this.rateLimitType = null;
    this.last = { rateInfo: null, rateLimits: null, usage: null }; // for status frames
  }

  // backoff for the Nth consecutive failure, with jitter, capped.
  _backoff(n) {
    const raw = this.cfg.baseMs * Math.pow(this.cfg.factor, Math.max(0, n - 1));
    const capped = Math.min(raw, this.cfg.maxBackoffMs);
    const j = capped * this.cfg.jitter;
    // jitter without Math.random unavailability concerns: derive from clock.
    const frac = (this.now() % 1000) / 1000; // 0..1
    return Math.round(capped - j + frac * 2 * j);
  }

  _open(retryAtMs, rateLimitType) {
    this.state = STATES.OPEN;
    this.openUntil = retryAtMs;
    this.rateLimitType = rateLimitType || null;
  }

  // Public: current breaker status (for rate_status frames to the panel).
  status() {
    return {
      state: this.state,
      openUntil: this.state === STATES.CLOSED ? null : this.openUntil,
      rateLimitType: this.rateLimitType,
      rateInfo: this.last.rateInfo,
      rateLimits: this.last.rateLimits,
      usage: this.last.usage,
    };
  }

  // Wrap a call to claude.ask(). `fn` is a thunk returning ask()'s promise.
  async run(fn) {
    const t = this.now();

    if (this.state === STATES.OPEN) {
      if (t < this.openUntil) {
        // Fail fast — do not spend a request we know will be rejected.
        throw new CircuitOpenError(this.openUntil, this.rateLimitType);
      }
      // Wait elapsed: allow a single probe.
      this.state = STATES.HALF_OPEN;
    }

    if (this.state === STATES.HALF_OPEN && this.probing) {
      // Someone else is already probing; don't pile on.
      throw new CircuitOpenError(this.openUntil, this.rateLimitType);
    }

    const isProbe = this.state === STATES.HALF_OPEN;
    if (isProbe) this.probing = true;

    try {
      const result = await fn();
      // Success — record telemetry and close.
      this.last = {
        rateInfo: result?.rateInfo ?? this.last.rateInfo,
        rateLimits: result?.rateLimits ?? this.last.rateLimits,
        usage: result?.usage ?? this.last.usage,
      };
      this.state = STATES.CLOSED;
      this.attempt = 0;
      this.rateLimitType = null;
      return result;
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.attempt += 1;
        this.last.rateInfo = { status: "rejected", rateLimitType: err.rateLimitType };
        // Prefer the server's reset time; fall back to exponential backoff.
        const retryAt =
          err.resetsAt && err.resetsAt > this.now()
            ? err.resetsAt
            : this.now() + this._backoff(this.attempt);
        this._open(retryAt, err.rateLimitType);
        throw new CircuitOpenError(retryAt, err.rateLimitType);
      }
      // Non-rate errors don't trip the breaker; surface them as-is. If this was
      // the half-open probe, drop back to OPEN so we don't hammer.
      if (isProbe) this.state = STATES.OPEN;
      throw err;
    } finally {
      if (isProbe) this.probing = false;
    }
  }
}
