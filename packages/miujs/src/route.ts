import type { AuthUser, Context } from "./context.ts";
import type { Schema } from "./schema.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * - `"required"`: 401 unless a user is signed in.
 * - `{ role }`: 401 when signed out, 403 without one of the roles.
 * - `"optional"` / `false` (default): anyone.
 */
export type AuthRequirement = "required" | "optional" | false | { role: string | string[] };

type MaybePromise<T> = T | Promise<T>;
type InferOr<S, D> = [S] extends [undefined] ? D : S extends Schema<infer T> ? T : D;
type UserFor<A> = A extends "required" | { role: string | string[] } ? { user: AuthUser } : {};

export type HandlerContext<P, Q, B, A> = Omit<Context, "params" | "query" | "body"> & {
  params: InferOr<P, Record<string, string>>;
  query: InferOr<Q, Record<string, string | string[]>>;
  body: InferOr<B, undefined>;
} & UserFor<A>;

/**
 * Route options added by plugins. Augment it to give a plugin a typed per-route option, and read
 * it in hooks from `ctx.route.config`:
 *
 * ```ts
 * declare module "miujs" { interface RouteExtensions { bots?: false | BotsRouteOptions } }
 * ```
 */
export interface RouteExtensions {}

export interface RouteConfig<P, Q, B, R, A> extends RouteExtensions {
  /** Stable identifier used for the MCP tool name and OpenAPI operationId. Defaults to the export name. */
  name?: string;
  /** One line describing what the route does. Shown to agents as the tool description. */
  summary?: string;
  description?: string;
  tags?: string[];
  params?: P;
  query?: Q;
  body?: B;
  response?: R;
  /** Status for successful plain-data responses. Default 200. */
  status?: number;
  auth?: A;
  /** Expose this route as an MCP tool when the app has `mcp` on. Default true. */
  mcp?: boolean;
  /**
   * Permission checked before validation via `ctx.authorize(permission)`, which an access plugin
   * such as @miujs/access provides. Shown in OpenAPI (`x-permission`) and the MCP tool description.
   */
  permission?: string;
  /** Largest request body in bytes for this route. Default: the app's `maxBodySize`. */
  maxBodySize?: number;
  /** Served, but hidden from inspect, OpenAPI and MCP (dev tools, plugin plumbing). */
  internal?: boolean;
  /** Override the MCP tool hints derived from the method (e.g. mark a POST bulk delete destructive). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Content type of a successful response when it isn't JSON (e.g. "text/csv"), for OpenAPI. */
  responseType?: string;
  handler: (ctx: HandlerContext<P, Q, B, A>) => MaybePromise<InferOr<R, unknown> | Response | void | null>;
}

export interface RouteDef {
  readonly __miu: "route";
  readonly method: Method;
  readonly path: string;
  readonly config: RouteConfig<any, any, any, any, any>;
  /** Filled from the export name when routes are passed as modules. */
  name?: string;
}

function make(method: Method) {
  return <
    P extends Schema | undefined = undefined,
    Q extends Schema | undefined = undefined,
    B extends Schema | undefined = undefined,
    R extends Schema | undefined = undefined,
    const A extends AuthRequirement = false,
  >(
    path: string,
    config: RouteConfig<P, Q, B, R, A>,
  ): RouteDef => ({ __miu: "route", method, path, config: config as RouteConfig<any, any, any, any, any>, name: config.name });
}

/**
 * Define a route. Handler, schemas and docs live together:
 *
 * ```ts
 * export const getUser = route.get("/users/:id", {
 *   params: t.object({ id: t.string() }),
 *   handler: ({ params }) => db.users.find(params.id),
 * });
 * ```
 */
export const route = {
  get: make("GET"),
  post: make("POST"),
  put: make("PUT"),
  patch: make("PATCH"),
  delete: make("DELETE"),
  head: make("HEAD"),
  options: make("OPTIONS"),
};

export function isRoute(v: unknown): v is RouteDef {
  return typeof v === "object" && v !== null && (v as RouteDef).__miu === "route";
}
