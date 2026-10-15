// Segment-based radix router. Fully static paths hit a single Map lookup; dynamic paths walk
// a tree with static > param > wildcard priority and backtracking.

import { errors } from "./errors.ts";

interface Node<T> {
  statics: Map<string, Node<T>> | null;
  // The same children as `statics`, as parallel arrays: a short list is scanned in place with
  // `startsWith`, which avoids slicing and hashing a segment string per request.
  staticKeys: string[];
  staticNodes: Node<T>[];
  param: { name: string; node: Node<T> } | null;
  wildcard: { name: string; value: T } | null;
  value: T | undefined;
}

function node<T>(): Node<T> {
  return { statics: null, staticKeys: [], staticNodes: [], param: null, wildcard: null, value: undefined };
}

/** Above this many static children a node uses its Map instead of a linear scan. */
const SCAN_LIMIT = 8;
/** Static paths are bucketed by length up to this, so most misses skip the Map lookup. */
const MAX_LEN = 255;

export interface Match<T> {
  value: T;
  params: Record<string, string>;
}

export function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path.startsWith("/") ? path : "/" + path;
}

/** Names of `:param` and `*wildcard` segments in a route pattern. */
export function pathParams(pattern: string): string[] {
  const out: string[] = [];
  for (const seg of normalizePath(pattern).split("/")) {
    if (seg.startsWith(":")) out.push(seg.slice(1));
    else if (seg.startsWith("*")) out.push(seg.slice(1) || "*");
  }
  return out;
}

function decode(s: string): string {
  if (s.indexOf("%") === -1) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export class Router<T> {
  private statics = new Map<string, T>();
  /**
   * `staticLens[n]`: how many static paths have length n, capped at 2 (n > MAX_LEN shares the
   * last slot). With exactly one, `soloPaths[n]`/`soloValues[n]` hold it, and a lookup is one
   * string comparison instead of hashing the path for the Map.
   */
  private staticLens = new Uint8Array(MAX_LEN + 2);
  private soloPaths: (string | undefined)[] = new Array(MAX_LEN + 2).fill(undefined);
  private soloValues: (T | undefined)[] = new Array(MAX_LEN + 2).fill(undefined);
  private root: Node<T> = node();
  private patterns: string[] = [];

  add(pattern: string, value: T): void {
    const path = normalizePath(pattern);
    this.patterns.push(path);
    if (!path.includes(":") && !path.includes("*")) {
      if (this.statics.has(path)) throw errors.config("MIU_E_ROUTE_DUPLICATE", `Route ${path} is defined twice`, "Remove or rename one of the routes.");
      this.statics.set(path, value);
      const slot = Math.min(path.length, MAX_LEN + 1);
      const n = (this.staticLens[slot] = Math.min(this.staticLens[slot] + 1, 2));
      // The overflow slot mixes lengths, so it always uses the Map.
      this.soloPaths[slot] = n === 1 && slot <= MAX_LEN ? path : undefined;
      this.soloValues[slot] = n === 1 && slot <= MAX_LEN ? value : undefined;
      return;
    }
    const segs = path.split("/").slice(1);
    let cur = this.root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.startsWith("*")) {
        if (i !== segs.length - 1) throw errors.config("MIU_E_ROUTE_INVALID", `Wildcard must be the last segment in ${path}`, "Move `*name` to the end of the path.");
        if (cur.wildcard) throw errors.config("MIU_E_ROUTE_DUPLICATE", `Route ${path} is defined twice`, "Remove or rename one of the routes.");
        cur.wildcard = { name: seg.slice(1) || "*", value };
        return;
      }
      if (seg.startsWith(":")) {
        const name = seg.slice(1);
        if (!cur.param) cur.param = { name, node: node() };
        else if (cur.param.name !== name)
          throw errors.config(
            "MIU_E_ROUTE_CONFLICT",
            `Route ${path} uses :${name} where another route uses :${cur.param.name}`,
            `Use the same parameter name (:${cur.param.name}) at this position in every route.`,
          );
        cur = cur.param.node;
      } else {
        if (!cur.statics) cur.statics = new Map();
        let next = cur.statics.get(seg);
        if (!next) {
          cur.statics.set(seg, (next = node()));
          cur.staticKeys.push(seg);
          cur.staticNodes.push(next);
        }
        cur = next;
      }
    }
    if (cur.value !== undefined) throw errors.config("MIU_E_ROUTE_DUPLICATE", `Route ${path} is defined twice`, "Remove or rename one of the routes.");
    cur.value = value;
  }

  find(path: string): Match<T> | null {
    const params: Record<string, string> = {};
    const value = this.lookup(path, params);
    return value === undefined ? null : { value, params };
  }

  /**
   * Like `find`, but writes path params into `params` and returns only the value, so the hot
   * path allocates no match object. Params are written only on a match.
   */
  lookup(path: string, params: Record<string, string>): T | undefined {
    const len = path.length;
    const s = this.matchStatic(path, len > MAX_LEN ? MAX_LEN + 1 : len);
    if (s !== undefined) return s;
    if (len > 1 && path.charCodeAt(len - 1) === 47 /* / */) {
      path = path.slice(0, -1);
      const t = this.matchStatic(path, len - 1 > MAX_LEN ? MAX_LEN + 1 : len - 1);
      if (t !== undefined) return t;
    }
    return this.walk(this.root, path, 1, params);
  }

  private matchStatic(path: string, slot: number): T | undefined {
    const n = this.staticLens[slot];
    if (n === 0) return undefined;
    if (n === 1 && slot <= MAX_LEN) return this.soloPaths[slot] === path ? this.soloValues[slot] : undefined;
    return this.statics.get(path);
  }

  // Walks the path string by index instead of splitting it: `split("/")` allocated an array per
  // request and was the router's main cost. `start` is where the current segment begins; it
  // passes the end of the string once every segment is consumed.
  private walk(n: Node<T>, path: string, start: number, params: Record<string, string>): T | undefined {
    if (start > path.length) return n.value;
    let end = path.indexOf("/", start);
    if (end === -1) end = path.length;
    const keys = n.staticKeys;
    if (keys.length !== 0) {
      let next: Node<T> | undefined;
      if (keys.length <= SCAN_LIMIT) {
        const segLen = end - start;
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (k.length === segLen && path.startsWith(k, start)) {
            next = n.staticNodes[i];
            break;
          }
        }
      } else {
        next = n.statics!.get(path.slice(start, end));
      }
      if (next) {
        const v = this.walk(next, path, end + 1, params);
        if (v !== undefined) return v;
      }
    }
    if (n.param && end !== start) {
      const v = this.walk(n.param.node, path, end + 1, params);
      if (v !== undefined) {
        params[n.param.name] = decode(path.slice(start, end));
        return v;
      }
    }
    if (n.wildcard) {
      params[n.wildcard.name] = decode(path.slice(start));
      return n.wildcard.value;
    }
    return undefined;
  }

  /** Every registered pattern, for 404 suggestions and introspection. */
  all(): readonly string[] {
    return this.patterns;
  }
}
