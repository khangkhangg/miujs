import type { Middleware, Route } from "../core/app.ts";
import type { AppLike } from "../core/context.ts";
import { toJSONSchema, type JSONSchema } from "../core/schema.ts";
import { objectParts, operationId, pathParamNames, toOpenAPIPath } from "./shared.ts";

export interface OpenAPIDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
}

export interface OpenAPIOptions {
  /** Where to serve the document. Default `/openapi.json`. */
  path?: string;
  servers?: { url: string }[];
}

const PROBLEM = {
  description: "Error (RFC 9457 problem details)",
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
};

export function generateOpenAPI(app: AppLike, opts: Omit<OpenAPIOptions, "path"> = {}): OpenAPIDocument & {
  components: Record<string, unknown>;
} {
  const paths: OpenAPIDocument["paths"] = {};
  for (const route of app.routes as Route[]) {
    if (route.meta.hidden || route.method === "ALL") continue;
    const p = toOpenAPIPath(route.path);
    const op = operation(route);
    (paths[p] ??= {})[route.method.toLowerCase()] = op;
  }
  const info: OpenAPIDocument["info"] = { title: app.config.name ?? "Miu app", version: app.config.version ?? "0.0.0" };
  if (app.config.description) info.description = app.config.description;
  return {
    openapi: "3.1.0",
    info,
    ...(opts.servers ? { servers: opts.servers } : {}),
    paths,
    components: {
      schemas: {
        Problem: {
          type: "object",
          properties: {
            type: { type: "string" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            code: { type: "string" },
          },
          required: ["type", "title", "status"],
        },
      },
    },
  };
}

function operation(route: Route): Record<string, unknown> {
  const m = route.meta;
  const op: Record<string, unknown> = { operationId: operationId(route) };
  if (m.summary) op.summary = m.summary;
  if (m.description) op.description = m.description;
  if (m.tags) op.tags = m.tags;
  if (m.deprecated) op.deprecated = true;

  const parameters: Record<string, unknown>[] = [];
  const params = objectParts(m.params);
  for (const name of pathParamNames(route.path)) {
    const key = name === "path" && route.path.endsWith("*") ? "*" : name;
    parameters.push({ name, in: "path", required: true, schema: params?.properties[key] ?? { type: "string" } });
  }
  const query = objectParts(m.query);
  if (query) {
    for (const [name, schema] of Object.entries(query.properties)) {
      parameters.push({ name, in: "query", required: query.required.includes(name), schema });
    }
  }
  const headers = objectParts(m.headers);
  if (headers) {
    for (const [name, schema] of Object.entries(headers.properties)) {
      parameters.push({ name, in: "header", required: headers.required.includes(name), schema });
    }
  }
  if (parameters.length) op.parameters = parameters;

  if (m.body) {
    op.requestBody = { required: true, content: { "application/json": { schema: toJSONSchema(m.body) } } };
  }

  const ok: Record<string, unknown> = { description: "Success" };
  if (m.response) ok.content = { "application/json": { schema: toJSONSchema(m.response) as JSONSchema } };
  const responses: Record<string, unknown> = { "200": ok };
  if (m.params || m.query || m.body || m.headers) {
    responses["422"] = { ...PROBLEM, description: "Validation failed" };
  }
  responses.default = PROBLEM;
  op.responses = responses;
  return op;
}

/** Middleware that serves the generated OpenAPI document. */
export function openapi(opts: OpenAPIOptions = {}): Middleware {
  const path = opts.path ?? "/openapi.json";
  let cached: unknown;
  return async (c, next) => {
    if (c.method === "GET" && c.url.pathname === path) {
      cached ??= generateOpenAPI(c.app, opts);
      return c.json(cached);
    }
    await next();
  };
}
