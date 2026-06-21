// Standalone test of the circuit-breaker state machine. No network, no Claude —
// we inject a fake `ask` and a controllable clock, and assert state transitions.
//
//   node bridge/rateguard.test.js

import { RateGuard, CircuitOpenError } from "./rateguard.js";
import { RateLimitError } from "./claude.js";

let clock = 1_000_000;
const now = () => clock;
let pass = 0,
  fail = 0;

function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

async function expectThrow(name, fn, Type) {
  try {
    await fn();
    check(name + " (threw)", false);
    return null;
  } catch (e) {
    check(name, e instanceof Type);
    return e;
  }
}

// ---- 1. server-provided resetsAt is honored ------------------------------
{
  const g = new RateGuard({ now });
  const resetsAt = clock + 30_000; // server says: back in 30s
  const okThunk = () => Promise.resolve({ text: "hi", rateInfo: { status: "allowed" } });
  const limitThunk = () =>
    Promise.reject(new RateLimitError({ rateLimitType: "five_hour", resetsAt: resetsAt / 1000 }));

  // First call hits the limit -> opens, throws CircuitOpenError with that time.
  const e = await expectThrow("open on RateLimitError", () => g.run(limitThunk), CircuitOpenError);
  check("retryAt == server resetsAt", e && e.retryAtMs === resetsAt);
  check("state OPEN", g.status().state === "open");
  check("bucket recorded", g.status().rateLimitType === "five_hour");

  // While open, calls fail fast WITHOUT invoking ask.
  let called = false;
  await expectThrow(
    "fail fast while open",
    () => g.run(() => ((called = true), okThunk())),
    CircuitOpenError,
  );
  check("ask not invoked while open", called === false);

  // Advance past reset -> half-open probe succeeds -> CLOSED.
  clock = resetsAt + 1;
  const r = await g.run(okThunk);
  check("probe returns result", r && r.text === "hi");
  check("state CLOSED after success", g.status().state === "closed");
}

// ---- 2. no resetsAt -> exponential backoff that grows --------------------
{
  clock = 5_000_000;
  const g = new RateGuard({ now, baseMs: 1000, factor: 2, jitter: 0 });
  const limitThunk = () => Promise.reject(new RateLimitError({ rateLimitType: "seven_day" }));

  const e1 = await expectThrow("backoff 1 opens", () => g.run(limitThunk), CircuitOpenError);
  const w1 = e1.retryAtMs - clock;

  // Jump to the probe window; probe fails again -> longer backoff.
  clock = e1.retryAtMs + 1;
  const e2 = await expectThrow("backoff 2 opens", () => g.run(limitThunk), CircuitOpenError);
  const w2 = e2.retryAtMs - clock;

  check(`backoff grows (${w1}ms -> ${w2}ms)`, w2 > w1);
}

// ---- 3. non-rate errors do NOT trip the breaker --------------------------
{
  clock = 9_000_000;
  const g = new RateGuard({ now });
  await expectThrow(
    "generic error propagates",
    () => g.run(() => Promise.reject(new Error("boom"))),
    Error,
  );
  check("stays CLOSED on generic error", g.status().state === "closed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
