// Segment-based radix router. Fully static paths hit a single Map lookup; dynamic paths walk
// a tree with static > param > wildcard priority and backtracking.

import { errors } from "./errors.ts";

interface Node<T> {
  statics: Map<string, Node<T>> | null;
  param: { name: string; node: Node<T> } | null;
  wildcard: { name: string; value: T } | null;
  value: T | undefined;
}

function node<T>(): Node<T> {
  return { statics: null, param: null, wildcard: null, value: undefined };
}

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
  private root: Node<T> = node();
  private patterns: string[] = [];

  add(pattern: string, value: T): void {
    const path = normalizePath(pattern);
    this.patterns.push(path);
    if (!path.includes(":") && !path.includes("*")) {
      if (this.statics.has(path)) throw errors.config("MIU_E_ROUTE_DUPLICATE", `Route ${path} is defined twice`, "Remove or rename one of the routes.");
      this.statics.set(path, value);
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
        if (!next) cur.statics.set(seg, (next = node()));
        cur = next;
      }
    }
    if (cur.value !== undefined) throw errors.config("MIU_E_ROUTE_DUPLICATE", `Route ${path} is defined twice`, "Remove or rename one of the routes.");
    cur.value = value;
  }

  find(path: string): Match<T> | null {
    const s = this.statics.get(path);
    if (s !== undefined) return { value: s, params: {} };
    if (path.length > 1 && path.endsWith("/")) {
      const t = this.statics.get(path.slice(0, -1));
      if (t !== undefined) return { value: t, params: {} };
      path = path.slice(0, -1);
    }
    const segs = path.split("/");
    const params: Record<string, string> = {};
    const value = this.walk(this.root, segs, 1, params);
    return value === undefined ? null : { value, params };
  }

  private walk(n: Node<T>, segs: string[], i: number, params: Record<string, string>): T | undefined {
    if (i === segs.length) return n.value;
    const seg = segs[i];
    if (n.statics) {
      const next = n.statics.get(seg);
      if (next) {
        const v = this.walk(next, segs, i + 1, params);
        if (v !== undefined) return v;
      }
    }
    if (n.param && seg !== "") {
      const v = this.walk(n.param.node, segs, i + 1, params);
      if (v !== undefined) {
        params[n.param.name] = decode(seg);
        return v;
      }
    }
    if (n.wildcard) {
      params[n.wildcard.name] = decode(segs.slice(i).join("/"));
      return n.wildcard.value;
    }
    return undefined;
  }

  /** Every registered pattern, for 404 suggestions and introspection. */
  all(): readonly string[] {
    return this.patterns;
  }
}
