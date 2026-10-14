import { redisScript, toRedisLike, type AnyRedisClient, type RedisLike } from "../store/redis.ts";
import type { Job, JobStatus, QueueDriver } from "./types.ts";

/**
 * Redis-backed queue driver for workers on several machines. Every state change is one Lua script,
 * so claims are atomic across workers and `complete`/`fail` are fenced by attempt number exactly
 * like the SQLite driver. Data layout under `prefix`:
 *
 * - `job:<id>`   hash with the job's fields (plus `m`, its sorted-set member, and `lockedUntil`)
 * - `pending`    zset of due-able jobs, scored by `runAt`
 * - `running`    zset of claimed jobs, scored by lock expiry (expired = reclaimable)
 * - `completed`, `failed`  zsets scored by `finishedAt` (for `prune`)
 * - `all`        zset of every job scored by `runAt` (for `list`)
 * - `k:<key>`    set of pending/running job ids holding a dedupe key
 *
 * Members are `<16-digit sequence>:<id>`, so jobs due at the same millisecond run in dispatch order.
 * Redis Cluster: use a hash-tagged prefix such as `"{miu}:queue:"` so all keys live in one slot.
 */

export interface RedisQueueOptions {
  /** Key prefix. Default `"miu:queue:"`. */
  prefix?: string;
}

const SEQ_LEN = 16;

const PUSH = redisScript(`
local P = ARGV[1]
local id = ARGV[2]
local key = ARGV[7]
if key ~= '' then
  local ks = P .. 'k:' .. key
  for _, jid in ipairs(redis.call('SMEMBERS', ks)) do
    local st = redis.call('HGET', P .. 'job:' .. jid, 'status')
    if st == 'pending' or (ARGV[8] == '1' and st == 'running') then
      return redis.call('HGETALL', P .. 'job:' .. jid)
    end
    if st ~= 'pending' and st ~= 'running' then redis.call('SREM', ks, jid) end
  end
end
local jk = P .. 'job:' .. id
local status = ARGV[9]
local m = string.format('%0${SEQ_LEN}d', redis.call('INCR', P .. 'seq')) .. ':' .. id
redis.call('HSET', jk, 'id', id, 'name', ARGV[3], 'payload', ARGV[4], 'status', status,
  'attempts', ARGV[10], 'runAt', ARGV[5], 'createdAt', ARGV[6], 'm', m)
if key ~= '' then redis.call('HSET', jk, 'key', key) end
if ARGV[11] ~= '' then redis.call('HSET', jk, 'lastError', ARGV[11]) end
if ARGV[12] ~= '' then redis.call('HSET', jk, 'finishedAt', ARGV[12]) end
redis.call('ZADD', P .. 'all', ARGV[5], m)
if status == 'pending' then
  redis.call('ZADD', P .. 'pending', ARGV[5], m)
  if key ~= '' then redis.call('SADD', P .. 'k:' .. key, id) end
elseif status == 'completed' or status == 'failed' then
  redis.call('ZADD', P .. status, ARGV[12] ~= '' and ARGV[12] or ARGV[6], m)
end
return redis.call('HGETALL', jk)
`);

const CLAIM = redisScript(`
local P = ARGV[1]
local p = redis.call('ZRANGEBYSCORE', P .. 'pending', '-inf', ARGV[2], 'LIMIT', 0, 1)[1]
local r = redis.call('ZRANGEBYSCORE', P .. 'running', '-inf', ARGV[2], 'LIMIT', 0, 1)[1]
local m = p or r
if p and r then
  local pr = tonumber(redis.call('ZSCORE', P .. 'all', p))
  local rr = tonumber(redis.call('ZSCORE', P .. 'all', r))
  if rr < pr or (rr == pr and r < p) then m = r end
end
if not m then return false end
local jk = P .. 'job:' .. string.sub(m, ${SEQ_LEN + 2})
redis.call('ZREM', P .. 'pending', m)
redis.call('ZADD', P .. 'running', ARGV[3], m)
redis.call('HSET', jk, 'status', 'running', 'lockedUntil', ARGV[3])
redis.call('HINCRBY', jk, 'attempts', 1)
return redis.call('HGETALL', jk)
`);

// Fencing: only the worker holding the current attempt of a running job may finish it.
const FENCE = `
local P = ARGV[1]
local id = ARGV[2]
local jk = P .. 'job:' .. id
if redis.call('HGET', jk, 'status') ~= 'running' or redis.call('HGET', jk, 'attempts') ~= ARGV[3] then return 0 end
local m = redis.call('HGET', jk, 'm')
local key = redis.call('HGET', jk, 'key')
redis.call('ZREM', P .. 'running', m)
redis.call('HDEL', jk, 'lockedUntil')
`;

const COMPLETE = redisScript(`${FENCE}
redis.call('HSET', jk, 'status', 'completed', 'finishedAt', ARGV[4])
redis.call('ZADD', P .. 'completed', ARGV[4], m)
if key then redis.call('SREM', P .. 'k:' .. key, id) end
return 1
`);

const FAIL = redisScript(`${FENCE}
redis.call('HSET', jk, 'lastError', ARGV[4])
if ARGV[5] == '' then
  redis.call('HSET', jk, 'status', 'failed', 'finishedAt', ARGV[6])
  redis.call('ZADD', P .. 'failed', ARGV[6], m)
  if key then redis.call('SREM', P .. 'k:' .. key, id) end
else
  redis.call('HSET', jk, 'status', 'pending', 'runAt', ARGV[5])
  redis.call('ZADD', P .. 'pending', ARGV[5], m)
  redis.call('ZADD', P .. 'all', ARGV[5], m)
end
return 1
`);

const RETRY = redisScript(`
local P = ARGV[1]
local jk = P .. 'job:' .. ARGV[2]
if redis.call('HGET', jk, 'status') ~= 'failed' then return 0 end
local m = redis.call('HGET', jk, 'm')
redis.call('HSET', jk, 'status', 'pending', 'attempts', 0, 'runAt', ARGV[3])
redis.call('HDEL', jk, 'finishedAt')
redis.call('ZREM', P .. 'failed', m)
redis.call('ZADD', P .. 'pending', ARGV[3], m)
redis.call('ZADD', P .. 'all', ARGV[3], m)
local key = redis.call('HGET', jk, 'key')
if key then redis.call('SADD', P .. 'k:' .. key, ARGV[2]) end
return 1
`);

const GET = redisScript(`return redis.call('HGETALL', ARGV[1] .. 'job:' .. ARGV[2])`);

const LIST = redisScript(`
local P = ARGV[1]
local limit = tonumber(ARGV[3])
local out = {}
if limit == 0 then return out end
for _, m in ipairs(redis.call('ZRANGE', P .. 'all', 0, -1)) do
  local jk = P .. 'job:' .. string.sub(m, ${SEQ_LEN + 2})
  if ARGV[2] == '' or redis.call('HGET', jk, 'status') == ARGV[2] then
    out[#out + 1] = redis.call('HGETALL', jk)
    if limit > 0 and #out >= limit then break end
  end
end
return out
`);

const BY_KEY = redisScript(`
local P = ARGV[1]
for _, jid in ipairs(redis.call('SMEMBERS', P .. 'k:' .. ARGV[2])) do
  local jk = P .. 'job:' .. jid
  if redis.call('HGET', jk, 'status') == 'pending' then return redis.call('HGETALL', jk) end
end
return false
`);

const PRUNE = redisScript(`
local P = ARGV[1]
local ms = redis.call('ZRANGEBYSCORE', P .. 'completed', '-inf', ARGV[2], 'LIMIT', 0, tonumber(ARGV[3]))
for _, m in ipairs(ms) do
  redis.call('DEL', P .. 'job:' .. string.sub(m, ${SEQ_LEN + 2}))
  redis.call('ZREM', P .. 'all', m)
  redis.call('ZREM', P .. 'completed', m)
end
return #ms
`);

const PRUNE_BATCH = 500;

/** Decode an HGETALL reply (flat array from Lua; tolerate maps from RESP3 clients). */
function toJob(reply: unknown): Job | undefined {
  let h: Record<string, string>;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return undefined;
    h = {};
    for (let i = 0; i < reply.length; i += 2) h[String(reply[i])] = String(reply[i + 1]);
  } else if (reply && typeof reply === "object") {
    h = reply as Record<string, string>;
    if (Object.keys(h).length === 0) return undefined;
  } else {
    return undefined;
  }
  const j: Job = {
    id: h.id!,
    name: h.name!,
    payload: JSON.parse(h.payload ?? "null"),
    status: h.status as JobStatus,
    attempts: Number(h.attempts),
    runAt: Number(h.runAt),
    createdAt: Number(h.createdAt),
  };
  if (h.lastError !== undefined) j.lastError = h.lastError;
  if (h.key !== undefined) j.key = h.key;
  if (h.finishedAt !== undefined) j.finishedAt = Number(h.finishedAt);
  return j;
}

/** Queue driver backed by Redis (see the module comment for the data layout). */
export function redisQueueDriver(client: AnyRedisClient, opts: RedisQueueOptions = {}): QueueDriver {
  const redis: RedisLike = toRedisLike(client);
  const P = opts.prefix ?? "miu:queue:";
  // Declaring one key lets cluster-aware clients route the script to the prefix's slot.
  const keys = [`${P}pending`];
  const run = (script: { run: typeof PUSH.run }, args: (string | number)[]) => script.run(redis, keys, [P, ...args]);

  return {
    async push(job, o) {
      const reply = await run(PUSH, [
        job.id, job.name, JSON.stringify(job.payload ?? null), job.runAt, job.createdAt, job.key ?? "",
        o?.dedupe === "active" ? "1" : "0", job.status, job.attempts, job.lastError ?? "", job.finishedAt ?? "",
      ]);
      return toJob(reply)!;
    },
    async claim(now, lockMs) {
      return toJob(await run(CLAIM, [now, now + lockMs]));
    },
    async complete(id, now, attempt) {
      return Number(await run(COMPLETE, [id, attempt, now])) === 1;
    },
    async fail(id, error, nextRunAt, now, attempt) {
      return Number(await run(FAIL, [id, attempt, error, nextRunAt ?? "", now])) === 1;
    },
    async get(id) {
      return toJob(await run(GET, [id]));
    },
    async list(o = {}) {
      const reply = (await run(LIST, [o.status ?? "", o.limit ?? -1])) as unknown[];
      return (reply ?? []).map((r) => toJob(r)!).filter(Boolean);
    },
    async findPendingByKey(key) {
      return toJob(await run(BY_KEY, [key]));
    },
    async retry(id, now) {
      return Number(await run(RETRY, [id, now])) === 1;
    },
    async prune(before) {
      let total = 0;
      for (;;) {
        const n = Number(await run(PRUNE, [before, PRUNE_BATCH]));
        total += n;
        if (n < PRUNE_BATCH) return total;
      }
    },
    async close() {},
  };
}
