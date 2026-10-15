import { expect, test } from "bun:test";
import { FakeClock } from "../src/clock.ts";

test("FakeClock runs due timers in order when advanced", () => {
  const c = new FakeClock(1000);
  const seen: string[] = [];
  c.setTimeout(() => seen.push(`b@${c.now()}`), 200);
  c.setTimeout(() => seen.push(`a@${c.now()}`), 100);
  const h = c.setTimeout(() => seen.push("never"), 150);
  c.clearTimeout(h);
  c.advance(150);
  expect(seen).toEqual(["a@1100"]);
  c.advance(100);
  expect(seen).toEqual(["a@1100", "b@1200"]);
  expect(c.now()).toBe(1250);
});

test("timers scheduled by timers fire within the same advance", () => {
  const c = new FakeClock(0);
  const seen: number[] = [];
  const loop = () => {
    seen.push(c.now());
    if (seen.length < 3) c.setTimeout(loop, 10);
  };
  c.setTimeout(loop, 10);
  c.advance(100);
  expect(seen).toEqual([10, 20, 30]);
});
