import type { Issue } from "./schema.ts";

/**
 * Throw from any handler or middleware. Rendered as RFC 9457 problem+json,
 * which both humans and agents can parse reliably.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: HeadersInit;

  constructor(
    status: number,
    message?: string,
    opts: { code?: string; details?: Record<string, unknown>; headers?: HeadersInit; cause?: unknown } = {},
  ) {
    super(message ?? STATUS_TEXT[status] ?? "Error", { cause: opts.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = opts.code;
    this.details = opts.details;
    this.headers = opts.headers;
  }

  toResponse(): Response {
    return problem(this.status, {
      detail: this.message !== STATUS_TEXT[this.status] ? this.message : undefined,
      code: this.code,
      ...this.details,
    }, this.headers);
  }
}

export class ValidationError extends HttpError {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(422, "Request validation failed", { code: "validation_failed", details: { issues } });
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function problem(status: number, extra: Record<string, unknown> = {}, headers?: HeadersInit): Response {
  const body: Record<string, unknown> = { type: "about:blank", title: STATUS_TEXT[status] ?? "Error", status };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) body[k] = v;
  const h = new Headers(headers);
  h.set("content-type", "application/problem+json");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
