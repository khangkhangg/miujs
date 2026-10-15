// An in-process Redis emulator at the command level (what `client.send(cmd, args)` sees), with
// TTLs on a fake clock. Wrapped by `redisFromCommand`, so tests exercise the real translation
// layer too. Replies mimic RESP3 as Bun's client returns them: strings, numbers, null, arrays.
import { redisFromCommand, type RedisLike } from "../src/redis.ts";

type Value = { type: "string"; v: string } | { type: "list"; v: string[] } | { type: "zset"; v: Map<string, number> };
interface Entry {
  value: Value;
  /** Expiry in ms, or Infinity. */
  exp: number;
}

export interface FakeRedis {
  command(cmd: string, args: string[]): Promise<unknown>;
  client: RedisLike;
  /** Every command sent, e.g. ["SET", "k", "v", "PX", "1000"]. */
  log: string[][];
  keys(): string[];
  /** Make every `cmd` command fail (until cleared with an empty list). */
  failCommands(cmds: string[]): void;
  /** Make the next `n` commands fail like a dropped connection. */
  failNext(n?: number): void;
}

const wrongType = () => new Error("WRONGTYPE Operation against a key holding the wrong kind of value");

/** Redis glob (`*`, `?`, `[...]`, backslash escapes) as a RegExp. */
function globToRegExp(glob: string): RegExp {
  const lit = (c: string) => c.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) out += lit(glob[++i]);
    else if (c === "*") out += "[\\s\\S]*";
    else if (c === "?") out += "[\\s\\S]";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) out += lit(c);
      else (out += `[${glob.slice(i + 1, close).replace(/\\/g, "\\\\")}]`), (i = close);
    } else out += lit(c);
  }
  return new RegExp(`^${out}$`);
}

function parseScore(s: string): number {
  if (s === "-inf") return -Infinity;
  if (s === "+inf" || s === "inf") return Infinity;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error("ERR min or max is not a float");
  return n;
}

export function fakeRedis(opts: { now?: () => number } = {}): FakeRedis {
  const now = opts.now ?? Date.now;
  const data = new Map<string, Entry>();
  // SCAN walks keys in creation order; a cursor is a position in it, so deleting keys while
  // scanning skips none of the others (the guarantee real Redis gives).
  const order: string[] = [];
  const known = new Set<string>();
  const rawSet = data.set.bind(data);
  data.set = (k: string, v: Entry) => {
    if (!known.has(k)) (known.add(k), order.push(k));
    return rawSet(k, v);
  };
  const log: string[][] = [];
  let failures = 0;
  let failing = new Set<string>();

  const live = (key: string): Entry | undefined => {
    const e = data.get(key);
    if (e && e.exp <= now()) {
      data.delete(key);
      return undefined;
    }
    return e;
  };
  const typed = <T extends Value["type"]>(key: string, type: T): Extract<Value, { type: T }> | undefined => {
    const e = live(key);
    if (!e) return undefined;
    if (e.value.type !== type) throw wrongType();
    return e.value as Extract<Value, { type: T }>;
  };
  const list = (key: string, create: boolean): string[] | undefined => {
    const l = typed(key, "list");
    if (l) return l.v;
    if (!create) return undefined;
    const v: string[] = [];
    data.set(key, { value: { type: "list", v }, exp: Infinity });
    return v;
  };
  const zset = (key: string, create: boolean): Map<string, number> | undefined => {
    const z = typed(key, "zset");
    if (z) return z.v;
    if (!create) return undefined;
    const v = new Map<string, number>();
    data.set(key, { value: { type: "zset", v }, exp: Infinity });
    return v;
  };
  // Redis deletes empty lists and sorted sets.
  const tidy = (key: string) => {
    const e = data.get(key);
    if (!e) return;
    if ((e.value.type === "list" && e.value.v.length === 0) || (e.value.type === "zset" && e.value.v.size === 0)) data.delete(key);
  };
  const sortedMembers = (z: Map<string, number>) => [...z].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const exec = (cmd: string, a: string[]): unknown => {
    switch (cmd) {
      case "GET": {
        const s = typed(a[0], "string");
        return s ? s.v : null;
      }
      case "SET": {
        const [key, value, ...rest] = a;
        let exp = Infinity;
        let nx = false;
        for (let i = 0; i < rest.length; i++) {
          const o = rest[i].toUpperCase();
          if (o === "EX") exp = now() + Number(rest[++i]) * 1000;
          else if (o === "PX") exp = now() + Number(rest[++i]);
          else if (o === "NX") nx = true;
          else throw new Error(`ERR syntax error (${o})`);
        }
        if (!Number.isFinite(exp) && exp !== Infinity) throw new Error("ERR invalid expire time");
        if (nx && live(key)) return null;
        data.set(key, { value: { type: "string", v: value }, exp });
        return "OK";
      }
      case "DEL": {
        let n = 0;
        for (const k of a) if (live(k) && data.delete(k)) n++;
        return n;
      }
      case "INCR": {
        const s = typed(a[0], "string");
        const n = (s ? Number(s.v) : 0) + 1;
        if (!Number.isInteger(n)) throw new Error("ERR value is not an integer or out of range");
        const exp = live(a[0])?.exp ?? Infinity;
        data.set(a[0], { value: { type: "string", v: String(n) }, exp });
        return n;
      }
      case "EXPIRE":
      case "PEXPIRE": {
        const e = live(a[0]);
        if (!e) return 0;
        e.exp = now() + Number(a[1]) * (cmd === "EXPIRE" ? 1000 : 1);
        return 1;
      }
      case "PTTL": {
        const e = live(a[0]);
        if (!e) return -2;
        return e.exp === Infinity ? -1 : e.exp - now();
      }
      case "ZADD": {
        const z = zset(a[0], true)!;
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!z.has(a[i + 1])) added++;
          z.set(a[i + 1], parseScore(a[i]));
        }
        return added;
      }
      case "ZREM": {
        const z = zset(a[0], false);
        if (!z) return 0;
        let n = 0;
        for (const m of a.slice(1)) if (z.delete(m)) n++;
        tidy(a[0]);
        return n;
      }
      case "ZSCORE": {
        const s = zset(a[0], false)?.get(a[1]);
        return s === undefined ? null : s;
      }
      case "ZCARD":
        return zset(a[0], false)?.size ?? 0;
      case "ZRANGEBYSCORE": {
        const [key, min, max, ...rest] = a;
        const lo = parseScore(min);
        const hi = parseScore(max);
        let out = sortedMembers(zset(key, false) ?? new Map())
          .filter(([, s]) => s >= lo && s <= hi)
          .map(([m]) => m);
        if (rest[0]?.toUpperCase() === "LIMIT") out = out.slice(Number(rest[1]), Number(rest[1]) + Number(rest[2]));
        return out;
      }
      case "LPUSH": {
        const l = list(a[0], true)!;
        for (const v of a.slice(1)) l.unshift(v);
        return l.length;
      }
      case "RPOPLPUSH": {
        const src = list(a[0], false);
        if (!src?.length) return null;
        const v = src.pop()!;
        tidy(a[0]);
        list(a[1], true)!.unshift(v);
        return v;
      }
      case "LREM": {
        const l = list(a[0], false);
        if (!l) return 0;
        let count = Number(a[1]);
        let n = 0;
        if (count < 0) throw new Error("fake: negative LREM count not supported");
        for (let i = 0; i < l.length; ) {
          if (l[i] === a[2] && (count === 0 || n < count)) {
            l.splice(i, 1);
            n++;
          } else i++;
        }
        tidy(a[0]);
        return n;
      }
      case "LRANGE": {
        const l = list(a[0], false) ?? [];
        const start = Number(a[1]);
        const stop = Number(a[2]);
        return l.slice(start < 0 ? Math.max(0, l.length + start) : start, stop < 0 ? l.length + stop + 1 : stop + 1);
      }
      case "LLEN":
        return list(a[0], false)?.length ?? 0;
      case "SCAN": {
        const start = Number(a[0]);
        let match = "*";
        let count = 10;
        for (let i = 1; i < a.length; i += 2) {
          const o = a[i].toUpperCase();
          if (o === "MATCH") match = a[i + 1];
          else if (o === "COUNT") count = Number(a[i + 1]);
          else throw new Error(`ERR syntax error (${o})`);
        }
        if (!Number.isInteger(start) || start < 0) throw new Error("ERR invalid cursor");
        const re = globToRegExp(match);
        const end = Math.min(order.length, start + Math.max(1, count));
        const keys = order.slice(start, end).filter((k) => live(k) && re.test(k));
        return [end >= order.length ? "0" : String(end), keys];
      }
      default:
        throw new Error(`ERR unknown command '${cmd}' (not in the fake)`);
    }
  };

  const command = async (cmd: string, args: string[]): Promise<unknown> => {
    log.push([cmd, ...args]);
    if (failing.has(cmd.toUpperCase())) throw new Error(`fake: ${cmd} failed`);
    if (failures > 0) {
      failures--;
      throw Object.assign(new Error("Connection closed"), { code: "ERR_REDIS_CONNECTION_CLOSED" });
    }
    if (!args.every((x) => typeof x === "string")) throw new Error(`fake: non-string argument to ${cmd}: ${JSON.stringify(args)}`);
    return exec(cmd.toUpperCase(), args);
  };

  return {
    command,
    client: redisFromCommand(command),
    log,
    keys: () => [...data.keys()].filter((k) => live(k)),
    failCommands(cmds) {
      failing = new Set(cmds);
    },
    failNext(n = 1) {
      failures = n;
    },
  };
}
