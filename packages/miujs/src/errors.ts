import type { Issue } from "./schema.ts";

/**
 * Where error codes are documented. `docs` in an error body is DOCS_BASE + the code in lowercase,
 * which is the anchor GitHub gives that code's heading in docs/errors.md.
 */
export const DOCS_BASE = "https://github.com/khangkhangg/miujs/blob/miujs-monorepo/docs/errors.md#";

/** Headers in any form `new Headers()` accepts, without needing the DOM lib's `HeadersInit`. */
export type HeadersLike = Headers | Record<string, string> | [string, string][];

export interface MiuErrorInit {
  /** Stable machine-readable code, e.g. `MIU_E_NOT_FOUND`. Never reworded once released. */
  code: string;
  status: number;
  message: string;
  /** What to change to make the error go away. Written for humans and coding agents. */
  fix?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Every error MiuJS produces. Serializes to
 * `{ "error": { "code", "message", "fix", "docs", "details" } }`.
 */
export class MiuError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fix?: string;
  readonly details?: unknown;

  constructor(init: MiuErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "MiuError";
    this.code = init.code;
    this.status = init.status;
    this.fix = init.fix;
    this.details = init.details;
  }

  toJSON() {
    const error: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.fix) error.fix = this.fix;
    error.docs = DOCS_BASE + this.code.toLowerCase();
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }

  toResponse(headers?: HeadersLike): Response {
    const h = new Headers(headers);
    h.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(this.toJSON()), { status: this.status, headers: h });
  }
}

export function isMiuError(e: unknown): e is MiuError {
  return e instanceof MiuError;
}

function describe(resource: string, id?: unknown): string {
  return id === undefined ? resource : `${resource} ${JSON.stringify(id)}`;
}

export const errors = {
  notFound: (resource: string, id?: unknown) =>
    new MiuError({ code: "MIU_E_NOT_FOUND", status: 404, message: `${describe(resource, id)} not found` }),

  badRequest: (message: string, fix?: string, details?: unknown) =>
    new MiuError({ code: "MIU_E_BAD_REQUEST", status: 400, message, fix, details }),

  validation: (where: "params" | "query" | "body" | "headers" | "response" | string, issues: Issue[]) =>
    new MiuError({
      code: where === "response" ? "MIU_E_RESPONSE_INVALID" : "MIU_E_VALIDATION",
      status: where === "response" ? 500 : 400,
      message:
        `Invalid ${where}: ` +
        issues
          .slice(0, 5)
          .map((i) => `${i.path || where} ${i.message}`)
          .join("; "),
      fix:
        where === "response"
          ? "The handler returned data that does not match the route's response schema. Fix the handler or the schema."
          : `Send ${where} that matches the route schema (see /_miu/openapi.json or the MCP tool input schema).`,
      details: { where, issues },
    }),

  unauthorized: (message = "Authentication required", fix = "Sign in, or send `Authorization: Bearer <token>`.") =>
    new MiuError({ code: "MIU_E_UNAUTHORIZED", status: 401, message, fix }),

  forbidden: (message = "You do not have permission to do this", fix?: string) =>
    new MiuError({ code: "MIU_E_FORBIDDEN", status: 403, message, fix }),

  conflict: (message: string, fix?: string) => new MiuError({ code: "MIU_E_CONFLICT", status: 409, message, fix }),

  tooManyRequests: (retryAfterSeconds?: number) =>
    new MiuError({
      code: "MIU_E_RATE_LIMITED",
      status: 429,
      message: "Too many requests",
      fix: retryAfterSeconds ? `Retry after ${retryAfterSeconds} seconds.` : "Slow down and retry later.",
      details: retryAfterSeconds ? { retryAfter: retryAfterSeconds } : undefined,
    }),

  internal: (message = "Internal server error", cause?: unknown) =>
    new MiuError({ code: "MIU_E_INTERNAL", status: 500, message, cause }),

  /** A configuration mistake found at startup. Thrown, never sent to clients. */
  config: (code: string, message: string, fix: string, details?: unknown) =>
    new MiuError({ code, status: 500, message, fix, details }),

  custom: (init: MiuErrorInit) => new MiuError(init),
};
