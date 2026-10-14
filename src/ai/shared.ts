import type { Route } from "../core/app.ts";
import { toJSONSchema, type AnySchema, type JSONSchema } from "../core/schema.ts";

/** `GET /products/:id` -> `get_products_by_id`. Stable and readable for agents. */
export function operationId(route: Pick<Route, "method" | "path" | "meta">): string {
  if (route.meta.operationId) return route.meta.operationId;
  const parts = route.path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg === "*" ? "by_path" : seg.startsWith(":") ? `by_${seg.slice(1)}` : seg))
    .map((seg) => seg.replace(/[^a-zA-Z0-9]+/g, "_"));
  return [route.method.toLowerCase(), ...(parts.length ? parts : ["root"])].join("_");
}

/** Names of path params in declaration order; wildcard is exposed as `path`. */
export function pathParamNames(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.startsWith(":") || s === "*")
    .map((s) => (s === "*" ? "path" : s.slice(1)));
}

export function toOpenAPIPath(path: string): string {
  return path
    .split("/")
    .map((s) => (s === "*" ? "{path}" : s.startsWith(":") ? `{${s.slice(1)}}` : s))
    .join("/");
}

export interface ObjectParts {
  properties: Record<string, JSONSchema>;
  required: string[];
}

/** Split an object schema into its properties and required list. */
export function objectParts(schema: AnySchema | undefined): ObjectParts | null {
  if (!schema) return null;
  const js = toJSONSchema(schema);
  if (!js.properties || typeof js.properties !== "object") return null;
  return {
    properties: js.properties as Record<string, JSONSchema>,
    required: Array.isArray(js.required) ? (js.required as string[]) : [],
  };
}
