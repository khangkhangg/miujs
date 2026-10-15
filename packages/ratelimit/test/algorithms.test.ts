import { describe, expect, test } from "bun:test";
import { isMiuError } from "miujs";
import { parseWindow, step, type Policy } from "../src/index.ts";

const S = 1000;
const M = 60 * S;

function run(policy: Policy, times: number[]) {
  let state: unknown = null;
  return times.map((now) => {
    const r = step(state, policy, now);
    state = r.state;
    return r.decision;
  });
}

describe("parseWindow", () => {
  test("accepts seconds and 10s/15m/1h/1d strings", () => {
    expect(parseWindow(30)).toBe(30 * S);
    expect(parseWindow("10s")).toBe(10 * S);
    expect(parseWindow("15m")).toBe(15 * M);
    expect(parseWindow("1h")).toBe(60 * M);
    expect(parseWindow("1d")).toBe(24 * 60 * M);
    expect(parseWindow("250ms")).toBe(250);
  });
  test("rejects nonsense with MIU_E_RATELIMIT_CONFIG and a fix", () => {
    for (const w of ["", "15", "1w", "-1m", 0, -5, Number.NaN, "1.5.m", "0m"]) {
      let err: any;
      try {
        parseWindow(w as any);
      } catch (e) {
        err = e;
      }
      expect(isMiuError(err) && err.code).toBe("MIU_E_RATELIMIT_CONFIG");
      expect(err.fix).toBeTruthy();
    }
  });
});

describe("fixed window", () => {
  const p: Policy = { algorithm: "fixed", limit: 3, windowMs: M, cost: 1 };

  test("allows `limit` per aligned window, then denies with Retry-After to the window end", () => {
    const t0 = 10 * M; // aligned
    const d = run(p, [t0, t0 + 1, t0 + 2, t0 + 20 * S]);
    expect(d.map((x) => x.allowed)).toEqual([true, true, true, false]);
    expect(d.map((x) => x.remaining)).toEqual([2, 1, 0, 0]);
    expect(d[3].retryAfterMs).toBe(40 * S);
    expect(d[3].resetMs).toBe(40 * S);
    expect(d[0].limit).toBe(3);
  });

  test("resets at the window boundary", () => {
    const t0 = 10 * M;
    const d = run(p, [t0, t0, t0, t0 + M - 1, t0 + M]);
    expect(d.map((x) => x.allowed)).toEqual([true, true, true, false, true]);
    expect(d[4].remaining).toBe(2);
  });

  test("denied hits are not counted", () => {
    const t0 = 10 * M;
    const d = run(p, [t0, t0, t0, t0, t0, t0, t0 + M]);
    expect(d[6]).toMatchObject({ allowed: true, remaining: 2 });
  });

  test("cost consumes several units", () => {
    const d = run({ ...p, cost: 2 }, [0, 0]);
    expect(d.map((x) => x.allowed)).toEqual([true, false]);
    expect(d[0].remaining).toBe(1);
  });
});

describe("sliding window (approximated from two fixed windows)", () => {
  const p: Policy = { algorithm: "sliding", limit: 10, windowMs: M, cost: 1 };

  test("smooths the boundary burst a fixed window allows", () => {
    const t0 = 10 * M;
    // 10 requests at the very end of one window...
    const times = Array.from({ length: 10 }, () => t0 + M - 1);
    // ...and 10 more right after the boundary: a fixed window would allow all 20.
    times.push(...Array.from({ length: 10 }, () => t0 + M + 1));
    const d = run(p, times);
    expect(d.slice(0, 10).every((x) => x.allowed)).toBe(true);
    expect(d.slice(10).filter((x) => x.allowed).length).toBe(0);
  });

  test("the previous window's weight decays linearly", () => {
    const t0 = 10 * M;
    const times = Array.from({ length: 10 }, () => t0);
    // Halfway through the next window, prev weighs 5: five more fit.
    times.push(...Array.from({ length: 6 }, () => t0 + M + 30 * S));
    const d = run(p, times);
    expect(d.slice(10).map((x) => x.allowed)).toEqual([true, true, true, true, true, false]);
  });

  test("Retry-After is when the estimate drops enough", () => {
    const t0 = 10 * M;
    const times = Array.from({ length: 10 }, () => t0);
    times.push(t0 + M); // prev = 10, weight 1 → denied
    const d = run(p, times);
    const last = d[10];
    expect(last.allowed).toBe(false);
    // Needs prev * (1 - x/M) <= 9 → x >= 6 s.
    expect(last.retryAfterMs).toBe(6 * S);
    const after = run(p, [...times.slice(0, 10), t0 + M + 6 * S]);
    expect(after[10].allowed).toBe(true);
  });

  test("Retry-After within the same window waits for the next window", () => {
    const t0 = 10 * M;
    const d = run(p, [...Array.from({ length: 10 }, () => t0), t0 + 15 * S]);
    expect(d[10].allowed).toBe(false);
    // At t0+M prev=10 weight 1 → still full; needs 6 s into the next window.
    expect(d[10].retryAfterMs).toBe(45 * S + 6 * S);
  });

  test("windows older than one window are forgotten", () => {
    const t0 = 10 * M;
    const d = run(p, [...Array.from({ length: 10 }, () => t0), t0 + 2 * M]);
    expect(d[10]).toMatchObject({ allowed: true, remaining: 9 });
  });
});

describe("token bucket", () => {
  const p: Policy = { algorithm: "token-bucket", limit: 10, windowMs: 10 * S, cost: 1, burst: 5 };

  test("starts full at `burst`, then refills at limit/window", () => {
    const d = run(p, [0, 0, 0, 0, 0, 0]);
    expect(d.map((x) => x.allowed)).toEqual([true, true, true, true, true, false]);
    // 1 token per second
    expect(d[5].retryAfterMs).toBe(S);
    const later = run(p, [0, 0, 0, 0, 0, 999, 1000]);
    expect(later.map((x) => x.allowed)).toEqual([true, true, true, true, true, false, true]);
  });

  test("never exceeds capacity after idling", () => {
    const d = run(p, [0, 10 * 60 * S]);
    expect(d[1].remaining).toBe(4);
  });

  test("burst defaults to limit", () => {
    const d = run({ ...p, burst: undefined }, Array.from({ length: 11 }, () => 0));
    expect(d.filter((x) => x.allowed).length).toBe(10);
  });

  test("reset is the time until the bucket is full again", () => {
    const [a] = run(p, [0]);
    expect(a.resetMs).toBe(S);
  });
});

describe("step", () => {
  test("returns a ttl after which the state can be dropped", () => {
    expect(step(null, { algorithm: "fixed", limit: 1, windowMs: M, cost: 1 }, 10 * M + 15 * S).ttlMs).toBe(45 * S);
    expect(step(null, { algorithm: "sliding", limit: 1, windowMs: M, cost: 1 }, 10 * M + 15 * S).ttlMs).toBe(45 * S + M);
    expect(step(null, { algorithm: "token-bucket", limit: 10, windowMs: 10 * S, cost: 1 }, 0).ttlMs).toBe(S);
  });

  test("garbage state is treated as empty (never trusted)", () => {
    const p: Policy = { algorithm: "fixed", limit: 2, windowMs: M, cost: 1 };
    for (const junk of [{ a: "f", s: 0, c: -100 }, { a: "f", s: 0, c: "x" }, "nope", 42, { a: "t", t: 1e9, u: 0 }]) {
      const r = step(junk, p, 0);
      expect(r.decision.remaining).toBe(1);
    }
    const tb: Policy = { algorithm: "token-bucket", limit: 2, windowMs: M, cost: 1 };
    expect(step({ a: "t", t: 1e9, u: 0 }, tb, 0).decision.remaining).toBe(1);
  });
});
