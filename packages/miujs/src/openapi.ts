import type { RouteDef } from "./route.ts";
import { pathParams } from "./router.ts";
import type { JsonSchema, Schema } from "./schema.ts";

export interface DescribedRoute {
  name: string;
  method: string;
  path: string;
  def: RouteDef;
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*([A-Za-z0-9_]*)/g, (_m, n) => `{${n || "wildcard"}}`);
}

/** Properties of an object schema, or `null` when the schema is not a plain object. */
export function objectProps(s: Schema | undefined): { props: Record<string, JsonSchema>; required: string[] } | null {
  if (!s) return null;
  const json = s.json;
  if (json.type !== "object" || typeof json.properties !== "object") return null;
  return { props: json.properties as Record<string, JsonSchema>, required: (json.required as string[]) ?? [] };
}

const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "docs"],
      properties: {
        code: { type: "string", examples: ["MIU_E_VALIDATION"] },
        message: { type: "string" },
        fix: { type: "string", description: "What to change to make the error go away." },
        docs: { type: "string", format: "uri" },
        details: {},
      },
    },
  },
};

export function generateOpenApi(routes: DescribedRoute[], info: OpenApiInfo): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const cfg = r.def.config;
    const parameters: unknown[] = [];
    const p = objectProps(cfg.params);
    for (const name of pathParams(r.path)) {
      // An unnamed `*` is templated as `{wildcard}` by toOpenApiPath, so the parameter must match.
      parameters.push({ name: name === "*" ? "wildcard" : name, in: "path", required: true, schema: p?.props[name] ?? { type: "string" } });
    }
    const q = objectProps(cfg.query);
    if (q) {
      for (const [name, schema] of Object.entries(q.props)) {
        parameters.push({ name, in: "query", required: q.required.includes(name), schema });
      }
    }
    const op: Record<string, unknown> = { operationId: r.name };
    if (cfg.summary) op.summary = cfg.summary;
    if (cfg.description) op.description = cfg.description;
    if (cfg.tags?.length) op.tags = cfg.tags;
    if (parameters.length) op.parameters = parameters;
    if (cfg.body) {
      op.requestBody = { required: !cfg.body.isOptional, content: { "application/json": { schema: cfg.body.json } } };
    }
    const status = String(cfg.status ?? 200);
    op.responses = {
      [status]: cfg.response
        ? { description: "Success", content: { "application/json": { schema: cfg.response.json } } }
        : { description: "Success" },
      default: { $ref: "#/components/responses/Error" },
    };
    if (cfg.auth && cfg.auth !== "optional") op.security = [{ bearer: [] }, { cookie: [] }];
    const key = toOpenApiPath(r.path);
    (paths[key] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info,
    paths,
    components: {
      schemas: { Error: ERROR_SCHEMA },
      responses: {
        Error: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        cookie: { type: "apiKey", in: "cookie", name: "miu_session" },
      },
    },
  };
}
