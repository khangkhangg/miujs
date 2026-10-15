// Reference test for clients/protocol-vectors.json: the vectors the Unity (C#) and Godot
// (GDScript) clients must satisfy. A literal transcription of the PROTOCOL.md patch algorithm and
// a minimal frame reducer run every vector here, and the server's own diff/applyPatch must agree.

import { expect, test } from "bun:test";
import { applyPatch, diff } from "@miujs/realtime";

const vectors = JSON.parse(await Bun.file(new URL("../../../clients/protocol-vectors.json", import.meta.url)).text());

/** PROTOCOL.md "Full apply algorithm", line by line (what the engine clients implement). */
function referenceApply(doc: any, ops: any[]): any {
  for (const op of ops) {
    if (op.path === "") {
      if (op.op !== "remove") doc = op.value;
      continue;
    }
    const keys = op.path.slice(1).split("/").map((k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    let parent = doc;
    for (const k of keys.slice(0, -1)) parent = parent[k];
    const last = keys[keys.length - 1];
    if (op.op === "remove") delete parent[last];
    else parent[last] = op.value;
  }
  return doc;
}

const TERMINAL = new Set<number>(vectors.reconnect.terminal);

/** What an engine client keeps after a sequence of server frames. */
function reduce(frames: string[]) {
  const s: any = { state: null, me: null, resumeToken: null, hostKey: null, events: [], errors: [], pongs: 0, welcomes: 0 };
  for (const raw of frames) {
    const f = JSON.parse(raw);
    switch (f.t) {
      case "welcome":
        s.me = f.me;
        s.resumeToken = f.resumeToken;
        if (f.hostKey) s.hostKey = f.hostKey;
        s.welcomes++;
        break;
      case "state":
        s.state = f.state;
        break;
      case "patch":
        s.state = referenceApply(s.state ?? {}, f.ops);
        break;
      case "event":
        s.events.push({ event: f.event, data: f.data ?? null });
        break;
      case "error":
        s.errors.push(f.code);
        break;
      case "pong":
        s.pongs++;
        break;
    }
  }
  return s;
}

test("the vectors file is versioned and non-trivial", () => {
  expect(vectors.version).toBe(1);
  expect(vectors.patch.length).toBeGreaterThanOrEqual(12);
  expect(vectors.sessions.length).toBeGreaterThanOrEqual(4);
});

for (const v of vectors.patch) {
  test(`patch: ${v.name}`, () => {
    expect(referenceApply(structuredClone(v.doc), v.ops)).toEqual(v.expected);
    expect(applyPatch(structuredClone(v.doc), v.ops)).toEqual(v.expected);
  });
}

for (const v of vectors.sessions) {
  test(`session: ${v.name}`, () => {
    const s = reduce(v.frames);
    for (const [k, want] of Object.entries(v.expect)) expect({ [k]: s[k] }).toEqual({ [k]: want });
  });
}

test("diff vectors: the server's diff turns `from` into `to` under the reference algorithm", () => {
  for (const v of vectors.diff) {
    const ops = diff(v.from, v.to);
    expect(ops).toEqual(v.ops);
    expect(referenceApply(structuredClone(v.from), ops)).toEqual(v.to);
  }
});

test("reconnect rules: terminal close codes never reconnect; others resume with the token", () => {
  for (const c of vectors.reconnect.cases) expect({ code: c.code, reconnect: !TERMINAL.has(c.code) }).toEqual({ code: c.code, reconnect: c.reconnect });
  expect(vectors.reconnect.resumeQuery).toBe("resume");
});

test("client frames are the exact JSON shapes the server accepts", () => {
  for (const c of vectors.clientFrames) expect(JSON.parse(c.json)).toEqual(c.frame);
  const kinds = vectors.clientFrames.map((c: any) => c.frame.t);
  expect(kinds).toEqual(expect.arrayContaining(["join", "msg", "ping"]));
});

test("random states: diff + reference apply round-trips (fuzz, fixed seed)", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const keys = ["a", "b", "c/d", "e~f", "ü", ""];
  const gen = (depth: number): any => {
    const r = rnd();
    if (depth > 2 || r < 0.3) return [null, true, 1, 2.5, "s", [1, 2]][Math.floor(rnd() * 6)];
    const o: any = {};
    for (const k of keys) if (rnd() < 0.5) o[k] = gen(depth + 1);
    return o;
  };
  for (let i = 0; i < 300; i++) {
    const a = gen(0);
    const b = gen(0);
    const from = typeof a === "object" && a && !Array.isArray(a) ? a : { v: a };
    const to = typeof b === "object" && b && !Array.isArray(b) ? b : { v: b };
    expect(referenceApply(structuredClone(from), diff(from, to))).toEqual(to);
  }
});
