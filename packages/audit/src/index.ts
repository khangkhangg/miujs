// @miujs/audit — a tamper-evident audit log: field-level diffs, secret redaction, an HMAC-SHA256
// (or legacy SHA-256) hash chain with key rotation, external anchoring, verification, retention
// with checkpoints, and auth-event logging.

export * from "./diff.ts";
export * from "./store.ts";
export * from "./plugin.ts";
export { hashAuditEmail, MIN_KEY_LENGTH, type AuditKey, type AuditKeys } from "./keys.ts";
export { anchorHead, anchorJob, anchorSignature, fileSink, httpSink, parseAnchor, type Anchor, type AnchorJob, type AnchorJobOptions, type AnchorOptions, type AnchorSink, type HttpSinkOptions } from "./anchor.ts";
