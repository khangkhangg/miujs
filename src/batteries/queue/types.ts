/**
 * Background job queue: jobs are persisted by a driver, claimed with a lock,
 * and retried with backoff. Drivers: memory (dev/tests) and SQLite (default).
 */

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface Job<P = unknown> {
  id: string;
  name: string;
  payload: P;
  status: JobStatus;
  /** Number of times the job has been claimed to run. */
  attempts: number;
  /** Earliest time (ms) the job may run. */
  runAt: number;
  lastError?: string;
  /** Dedupe key: dispatching with a key that is already pending returns that job. */
  key?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface QueueDriver {
  /** Store a new job. If `job.key` matches a pending job, store nothing and return that job instead. */
  push(job: Job): Promise<Job>;
  /**
   * Atomically take one due pending job (or a running job whose lock expired),
   * mark it running until `now + lockMs`, and increment its attempts.
   */
  claim(now: number, lockMs: number): Promise<Job | undefined>;
  /**
   * Mark a running job completed. `attempt` fences stale workers: the update applies only while the job is
   * still running under that attempt number (a reclaimed job has a higher one). Returns whether it applied.
   */
  complete(id: string, now: number, attempt: number): Promise<boolean>;
  /** Record a failed attempt: reschedule at `nextRunAt`, or fail permanently when it is null. Fenced like `complete`. */
  fail(id: string, error: string, nextRunAt: number | null, now: number, attempt: number): Promise<boolean>;
  get(id: string): Promise<Job | undefined>;
  list(opts?: { status?: JobStatus; limit?: number }): Promise<Job[]>;
  findPendingByKey(key: string): Promise<Job | undefined>;
  /** Move a failed job back to pending with its attempts reset. Returns false if it was not failed. */
  retry(id: string, now: number): Promise<boolean>;
  /** Delete completed jobs that finished at or before `before` (ms). Returns how many were deleted. */
  prune(before: number): Promise<number>;
  close(): Promise<void>;
}
