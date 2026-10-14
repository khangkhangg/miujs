/**
 * Minimal Cloudflare binding interfaces: only the members Miu uses, written to be
 * structurally compatible with `@cloudflare/workers-types` so real bindings can be
 * passed in directly without that package being a dependency.
 */

/** A binding passed directly, or a getter resolved on every call (e.g. `() => env.KV`). */
export type BindingRef<T> = T | (() => T);

/** Resolve a {@link BindingRef}. */
export function resolveBinding<T>(ref: BindingRef<T>): T {
  return typeof ref === "function" ? (ref as () => T)() : ref;
}

// ----- Workers KV -----

export interface KVNamespacePutOptions {
  /** Absolute expiry, seconds since epoch. */
  expiration?: number;
  /** Seconds from now; Cloudflare requires at least 60. */
  expirationTtl?: number;
  metadata?: unknown;
}

export interface KVNamespace {
  get(key: string, type: "text"): Promise<string | null>;
  getWithMetadata<M = unknown>(key: string, type: "text"): Promise<{ value: string | null; metadata: M | null }>;
  put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

// ----- D1 -----

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

// ----- R2 -----

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export type R2Range = { offset: number; length?: number } | { offset?: number; length: number } | { suffix: number };

export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  /** The etag wrapped in quotes, ready for an `ETag` header. */
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly range?: R2Range;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2GetOptions {
  range?: R2Range;
  onlyIf?: R2Conditional;
}

export interface R2ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  /** Returns an object without `body` when an `onlyIf` precondition fails. */
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}

// ----- Queues -----

export interface QueueSendOptions {
  delaySeconds?: number;
  contentType?: "text" | "bytes" | "json" | "v8";
}

/** A Queue producer binding. */
export interface QueueProducer<Body = unknown> {
  send(body: Body, options?: QueueSendOptions): Promise<void>;
}

export interface QueueRetryOptions {
  delaySeconds?: number;
}

export interface Message<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  /** 1 on the first delivery. */
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

export interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
}

// ----- Durable Objects -----

export interface DurableObjectId {
  toString(): string;
}

/** Only string URLs and plain init objects are used, so real stubs are assignable. */
export interface DurableObjectStub {
  fetch(input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string; limit?: number; start?: string }): Promise<Map<string, T>>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
}

export interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

// ----- Workflows -----

export interface WorkflowInstance {
  readonly id: string;
  status(): Promise<unknown>;
}

/** A Workflow binding (`env.MY_WORKFLOW`). */
export interface Workflow<P = unknown> {
  create(options?: { id?: string; params?: P }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

export interface WorkflowEvent<P = unknown> {
  readonly payload: Readonly<P>;
  readonly timestamp: Date;
  readonly instanceId: string;
}

/** The subset of `WorkflowStep` most workflows use. */
export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number | string): Promise<void>;
}

// ----- Hyperdrive -----

export interface Hyperdrive {
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

// ----- Worker entry -----

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}
