// Minimal JSON-Patch (RFC 6902 subset: add / remove / replace) between two JSON values.
// Plain objects are diffed key by key; arrays and primitives are replaced whole. Pure and
// dependency-free so the browser client can share it.

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function escape(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescape(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Deep equality for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Ops that turn `prev` into `next`. */
export function diff(prev: unknown, next: unknown, path = "", out: PatchOp[] = []): PatchOp[] {
  if (isObject(prev) && isObject(next)) {
    for (const k of Object.keys(prev)) {
      const p = `${path}/${escape(k)}`;
      if (!Object.prototype.hasOwnProperty.call(next, k) || next[k] === undefined) {
        if (prev[k] !== undefined) out.push({ op: "remove", path: p });
      } else {
        diff(prev[k], next[k], p, out);
      }
    }
    for (const k of Object.keys(next)) {
      if (next[k] === undefined) continue;
      if (!Object.prototype.hasOwnProperty.call(prev, k) || prev[k] === undefined) {
        out.push({ op: "add", path: `${path}/${escape(k)}`, value: next[k] });
      }
    }
    return out;
  }
  if (!jsonEqual(prev, next)) out.push({ op: "replace", path, value: next });
  return out;
}

/** Applies ops in place (returns the new root, which differs only for a root replace). */
export function applyPatch<T = any>(doc: unknown, ops: readonly PatchOp[]): T {
  let root = doc;
  for (const op of ops) {
    if (op.path === "") {
      if (op.op !== "remove") root = op.value;
      continue;
    }
    const segs = op.path.slice(1).split("/").map(unescape);
    const last = segs.pop()!;
    let parent: any = root;
    for (const s of segs) {
      if (!isObject(parent[s])) parent[s] = {};
      parent = parent[s];
    }
    if (op.op === "remove") delete parent[last];
    else parent[last] = op.value;
  }
  return root as T;
}
