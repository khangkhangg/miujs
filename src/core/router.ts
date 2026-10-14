/**
 * Segment-trie router. Static segments are checked before params, params
 * before wildcards. Lookup cost is proportional to path depth, not route count.
 */

export interface Match<H> {
  handler: H;
  params: Record<string, string>;
}

interface Node<H> {
  static: Map<string, Node<H>>;
  param?: { name: string; node: Node<H> };
  wildcard?: Map<string, H>;
  handlers: Map<string, H>;
}

const node = <H>(): Node<H> => ({ static: new Map(), handlers: new Map() });

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export class Router<H> {
  private root: Node<H> = node();
  /** Param-free paths resolve with one map lookup instead of a trie walk. */
  private statics = new Map<string, Map<string, H>>();

  add(method: string, path: string, handler: H): void {
    if (!path.includes(":") && !path.includes("*")) {
      const key = "/" + split(path).join("/");
      let m = this.statics.get(key);
      if (!m) this.statics.set(key, (m = new Map()));
      m.set(method, handler);
    }
    let cur = this.root;
    const segments = split(path);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg === "*") {
        if (i !== segments.length - 1) throw new Error(`Wildcard must be last segment: ${path}`);
        (cur.wildcard ??= new Map()).set(method, handler);
        return;
      }
      if (seg.startsWith(":")) {
        const name = seg.slice(1);
        if (cur.param && cur.param.name !== name) {
          throw new Error(`Conflicting param names ":${cur.param.name}" and ":${name}" in ${path}`);
        }
        cur.param ??= { name, node: node() };
        cur = cur.param.node;
      } else {
        let next = cur.static.get(seg);
        if (!next) cur.static.set(seg, (next = node()));
        cur = next;
      }
    }
    cur.handlers.set(method, handler);
  }

  find(method: string, path: string): Match<H> | null {
    const exact = this.statics.get(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
    if (exact) {
      const handler = pick(exact, method);
      if (handler !== undefined) return { handler, params: {} };
    }
    const params: Record<string, string> = {};
    const handlers = this.walk(this.root, split(path), 0, params, method);
    if (!handlers) return null;
    const handler = pick(handlers, method);
    return handler === undefined ? null : { handler, params };
  }

  allowedMethods(path: string): string[] {
    const handlers = this.walk(this.root, split(path), 0, {}, null);
    return handlers ? [...handlers.keys()] : [];
  }

  /** Returns the handler map at the deepest match; `method` (if set) prunes branches lacking it. */
  private walk(
    n: Node<H>,
    segs: string[],
    i: number,
    params: Record<string, string>,
    method: string | null,
  ): Map<string, H> | null {
    if (i === segs.length) {
      if (n.handlers.size && (method === null || pick(n.handlers, method) !== undefined)) return n.handlers;
      if (n.wildcard && (method === null || pick(n.wildcard, method) !== undefined)) {
        params["*"] = "";
        return n.wildcard;
      }
      return null;
    }
    const seg = segs[i]!;
    const s = n.static.get(seg);
    if (s) {
      const r = this.walk(s, segs, i + 1, params, method);
      if (r) return r;
    }
    if (n.param) {
      const r = this.walk(n.param.node, segs, i + 1, params, method);
      if (r) {
        params[n.param.name] = decode(seg);
        return r;
      }
    }
    if (n.wildcard && (method === null || pick(n.wildcard, method) !== undefined)) {
      params["*"] = segs.slice(i).map(decode).join("/");
      return n.wildcard;
    }
    return null;
  }
}

function pick<H>(handlers: Map<string, H>, method: string): H | undefined {
  return handlers.get(method) ?? (method === "HEAD" ? handlers.get("GET") : undefined) ?? handlers.get("ALL");
}
