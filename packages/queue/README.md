# @miujs/queue

> Background jobs and cron schedules for MiuJS, with retries, backoff and dead letters, on memory, SQLite, Redis or Cloudflare Queues.

`@miujs/queue` adds `ctx.queue.dispatch(job, input, { delay })`. Jobs are declared with `defineJob`, take a `t` schema for input, and are retried with backoff when they throw. Cron schedules dispatch a job on a 5-field UTC expression. With no adapter it runs jobs in-process on Bun, Deno and Node, and uses Cloudflare Queues (binding `JOBS`) on Workers.

## Install

```bash
bun add @miujs/queue miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { defineJob, queue } from "@miujs/queue";

export const sendEmail = defineJob("send-email", {
  input: t.object({ to: t.string() }),
  retries: 3,
  run: async ({ input, attempt, log }) => {
    log.info("sending", { to: input.to, attempt });
  },
});

export const signup = route.post("/signup", {
  body: t.object({ email: t.string() }),
  handler: async ({ body, queue }) => {
    const { id } = await queue.dispatch(sendEmail, { to: body.email });
    return { queued: id };
  },
});

const app = miu({ name: "queue-demo", routes: [signup], plugins: [queue({ jobs: [sendEmail] })] });
export default app;
```

`dispatch` validates the input against the job's schema and resolves once the message is accepted, not when it has run. Pass `{ delay: seconds }` to wait before the first attempt.

## Jobs

A job's `run` receives `{ input, attempt, maxAttempts, id, job, log, env, dispatch }`. `attempt` is 1 on the first try; `id` is stable across retries. `dispatch` enqueues another job.

- A thrown error retries the job after its `backoff` until `retries` are used up, then the message becomes a dead letter.
- `backoff: "exponential"` waits 5 s, 10 s, 20 s, ... up to 1 h; a number is a fixed delay in seconds.
- Invalid input and unknown jobs are never retried.

## Schedules

`schedule(cron, job, input?)` runs `job` whenever the expression matches. Expressions have 5 fields (minute, hour, day of month, month, day of week), support `*`, numbers, `a-b`, `a,b` and `/n`, and are matched in UTC. Scheduled jobs are registered automatically.

<!-- test -->
```ts
import { miu, t } from "miujs";
import { defineJob, queue, schedule } from "@miujs/queue";

const report = defineJob("daily-report", {
  input: t.object({ day: t.string() }),
  backoff: 30,
  run: async ({ input, log }) => {
    log.info("report", { day: input.day });
  },
});

const jobs = queue({ schedules: [schedule("0 6 * * *", report, { day: "today" })] });

export default miu({ name: "cron-demo", plugins: [jobs] });
```

On Bun, Deno and Node the adapter fires schedules itself. On Workers they run from Cron Triggers.

## Adapters

### Memory (default off Workers)

`memoryQueue({ concurrency, clock })` runs jobs in this process; they are lost if it exits. It keeps `deadLetters` in memory and `drain()` resolves once nothing is queued, running or delayed. With `manualClock()`, `drain()` skips delays and backoff, which makes job tests fast.

<!-- test -->
```ts
import { t } from "miujs";
import { defineJob, manualClock, memoryQueue, queue } from "@miujs/queue";

let failures = 0;
const flaky = defineJob("flaky", {
  input: t.object({}),
  retries: 1,
  run: () => {
    failures++;
    throw new Error("boom");
  },
});

const adapter = memoryQueue({ clock: manualClock() });
const q = queue({ jobs: [flaky], adapter });

await q.dispatch(flaky, {});
await adapter.drain();
console.log(failures, adapter.deadLetters.length); // 2 1
q.stop();
```

The plugin's own `dispatch(job, input, opts?, env?)` works outside requests (scripts, tests); `stop()` clears schedule and delay timers.

### SQLite (Bun only)

`sqliteQueue(pathOrDatabase, options)` keeps jobs in a `bun:sqlite` file, so they survive restarts. Several processes on one machine can share the file. A job whose process dies is rerun after `visibilityTimeout`.

<!-- test -->
```ts
import { Database } from "bun:sqlite";
import { t } from "miujs";
import { defineJob, queue, sqliteQueue } from "@miujs/queue";

const job = defineJob("resize", { input: t.object({ file: t.string() }), run: () => {} });
const adapter = sqliteQueue(new Database(":memory:"), { table: "jobs", concurrency: 2 });
const q = queue({ jobs: [job], adapter });

await q.dispatch(job, { file: "a.png" });
console.log(await adapter.stats()); // { pending, delayed, inflight, deadLetters }
adapter.close();
```

Pass a path (`sqliteQueue("./data/jobs.sqlite")`) to let the queue open and own the database. Dead letters and schedule locks use `<table>_dead` and `<table>_once`.

### Redis

`redisQueue(client, options)` shares one queue between servers. `bunRedis()` and `redisFromCommand()` from `@miujs/cache` provide the client.

```ts
import { bunRedis } from "@miujs/cache";
import { queue, redisQueue } from "@miujs/queue";

queue({ jobs, adapter: redisQueue(bunRedis(), { concurrency: 4 }) });
```

SQLite and Redis adapters are `DurableQueue`s: `drain()`, `stop()`, `close()`, `listDeadLetters()` and `stats()`. Jobs receive the process env, not the dispatching request's env.

### Cloudflare Queues (default on Workers)

`cloudflareQueue({ binding, queue })` sends `{ id, job, input }` to the producer binding and runs the consumer through `app.on("queue")`. See [Cloudflare Workers](#cloudflare-workers).

## Options

`queue(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `jobs` | `JobDef[]` | `[]` | Jobs this queue can run. |
| `schedules` | `Schedule[]` | `[]` | Cron schedules; their jobs are registered automatically. |
| `adapter` | `QueueAdapter` | `memoryQueue()`; `cloudflareQueue()` on Workers | Queue backend. |

`defineJob(name, config)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `input` | `Schema` | required | `t` schema for the input; `t.object({})` for none. |
| `retries` | `number` | `3` | Retries after the first failed attempt. |
| `backoff` | `"exponential" \| number` | `"exponential"` | Delay before each retry (seconds when a number). |
| `run` | `(ctx) => unknown` | required | The job body. |

`memoryQueue(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `concurrency` | `number` | `1` | Jobs run at the same time. |
| `clock` | `Clock` | `realClock` | Time source; `manualClock()` in tests. |

`sqliteQueue` / `redisQueue` options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `concurrency` | `number` | `1` | Jobs this process runs at the same time. |
| `visibilityTimeout` | `number` | `30` | Seconds a running job's lease lasts; renewed while it runs. |
| `pollInterval` | `number` | `1000` | Milliseconds between checks for due jobs. |
| `clock` | `Clock` | `realClock` | Time source. |
| `table` (SQLite) | `string` | `"miu_jobs"` | Table name. |
| `prefix` (Redis) | `string` | `"miu:queue:"` | Key prefix. |

`cloudflareQueue(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binding` | `string` | `"JOBS"` | Producer binding name. |
| `queue` | `string` | all batches | Only consume batches from this queue name. |

## Errors

- [`MIU_E_VALIDATION`](../../docs/errors.md#miu_e_validation): job input does not match its schema.
- [`MIU_E_QUEUE_CONFIG`](../../docs/errors.md#miu_e_queue_config): invalid job, adapter or option.
- [`MIU_E_QUEUE_CRON`](../../docs/errors.md#miu_e_queue_cron): invalid cron expression.
- [`MIU_E_QUEUE_UNKNOWN_JOB`](../../docs/errors.md#miu_e_queue_unknown_job): the job is not registered with this queue.
- [`MIU_E_QUEUE_JOB_DUPLICATE`](../../docs/errors.md#miu_e_queue_job_duplicate): two jobs share a name.
- [`MIU_E_QUEUE_DELAY`](../../docs/errors.md#miu_e_queue_delay): `delay` is negative or too long (12 h on Cloudflare).
- [`MIU_E_QUEUE_BINDING`](../../docs/errors.md#miu_e_queue_binding): the Cloudflare Queue binding is missing.
- [`MIU_E_QUEUE_TIMEOUT`](../../docs/errors.md#miu_e_queue_timeout): a job's lease ran out with no attempts left.
- [`MIU_E_QUEUE_RUNTIME`](../../docs/errors.md#miu_e_queue_runtime): adapter used on an unsupported runtime (e.g. SQLite off Bun).
- [`MIU_E_QUEUE_SQLITE`](../../docs/errors.md#miu_e_queue_sqlite) / [`MIU_E_QUEUE_REDIS`](../../docs/errors.md#miu_e_queue_redis): a backend operation failed.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

On Workers the default adapter is `cloudflareQueue()` with producer and consumer binding `JOBS`. Successful messages are acked; failures call `retry({ delaySeconds })` with the job's backoff until its retries are used up. Set `max_retries` above your largest `retries` so Cloudflare does not give up first. Schedules run from Cron Triggers whose cron equals the schedule's.

```toml
[[queues.producers]]
binding = "JOBS"
queue = "<queue-name>"

[[queues.consumers]]
queue = "<queue-name>"
max_retries = 10

[triggers]
crons = ["0 6 * * *"]
```

`miu deploy cloudflare` reads the producer, consumer and crons from the plugin. `sqliteQueue` is Bun only and `memoryQueue` is per isolate; `redisQueue` needs a TCP Redis client, so use `cloudflareQueue` on Workers.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/cache](../cache/README.md), [@miujs/db](../db/README.md), [@miujs/ratelimit](../ratelimit/README.md)
