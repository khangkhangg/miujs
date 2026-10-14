import type { Middleware, Route } from "../core/app.ts";
import type { AppLike } from "../core/context.ts";
import { toJSONSchema, type JSONSchema } from "../core/schema.ts";
import { objectParts, operationId, pathParamNames, toOpenAPIPath } from "./shared.ts";

/**
 * llms.txt (https://llmstxt.org) generated from route metadata: a short,
 * Markdown index an LLM can read to learn what the app does and how to call it.
 */

export interface LlmsLink {
  title: string;
  url: string;
  description?: string;
}

export interface LlmsSection {
  title: string;
  links: LlmsLink[];
}

export interface LlmsOptions {
  /** Absolute origin for links (e.g. `https://api.example.com`). Relative links when omitted. */
  baseUrl?: string;
  /** Free text placed after the summary. */
  intro?: string;
  /** Extra link sections appended after the generated ones. */
  sections?: LlmsSection[];
  /** Where `mcp()` is mounted, or `false` to omit. Default `/mcp`. */
  mcpPath?: string | false;
  /** Where `openapi()` is mounted, or `false` to omit. Default `/openapi.json`. */
  openapiPath?: string | false;
  /** Where the full document is served, or `false` to omit. Default `/llms-full.txt`. */
  fullPath?: string | false;
}

export interface LlmsMiddlewareOptions extends LlmsOptions {
  /** Default `/llms.txt`. */
  path?: string;
  /** Default `/llms-full.txt`. */
  fullPath?: string;
}

const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Routes worth documenting: standard verbs, not hidden, exposed as tools. */
function documented(app: AppLike): Route[] {
  return (app.routes as Route[]).filter((r) => VERBS.has(r.method) && !r.meta.hidden && r.meta.tool !== false);
}

const toolName = (r: Route) => (typeof r.meta.tool === "object" && r.meta.tool.name) || operationId(r);
const joinUrl = (base: string | undefined, path: string) => (base ? base.replace(/\/+$/, "") : "") + path;

/** Short human type label for a JSON Schema: `integer`, `string[]`, `"a" | "b"`. */
function typeLabel(s: JSONSchema | undefined): string {
  if (!s) return "any";
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.anyOf)) return (s.anyOf as JSONSchema[]).map(typeLabel).join(" | ");
  if (s.type === "array") return `${typeLabel(s.items as JSONSchema)}[]`;
  if (typeof s.type === "string") return s.format ? `${s.type}, ${s.format}` : s.type;
  return "any";
}

interface Field {
  name: string;
  schema: JSONSchema | undefined;
  required: boolean;
}

function inputFields(r: Route): Field[] {
  const fields: Field[] = [];
  const params = objectParts(r.meta.params);
  for (const name of pathParamNames(r.path)) {
    const key = name === "path" && r.path.endsWith("*") ? "*" : name;
    fields.push({ name, schema: params?.properties[key] ?? { type: "string" }, required: true });
  }
  for (const schema of [r.meta.query, r.meta.body]) {
    if (!schema) continue;
    const parts = objectParts(schema);
    if (!parts) {
      fields.push({ name: "body", schema: toJSONSchema(schema), required: true });
      continue;
    }
    for (const [name, s] of Object.entries(parts.properties)) {
      fields.push({ name, schema: s, required: parts.required.includes(name) });
    }
  }
  return fields;
}

function fieldLabel(f: Field): string {
  const bits = [typeLabel(f.schema)];
  if (!f.required) bits.push("optional");
  if (f.schema?.default !== undefined) bits.push(`default ${JSON.stringify(f.schema.default)}`);
  return `${f.name} (${bits.join(", ")})`;
}

function header(app: AppLike, opts: LlmsOptions): string[] {
  const out = [`# ${app.config.name ?? "Miu app"}`, ""];
  if (app.config.description) out.push(`> ${app.config.description}`, "");
  const version = app.config.version ? `Version ${app.config.version}. ` : "";
  out.push(`${version}Every operation below is an HTTP endpoint and an MCP tool with the same input.`, "");
  if (opts.intro) out.push(opts.intro.trim(), "");
  return out;
}

function agentLinks(opts: LlmsOptions, full: boolean): LlmsLink[] {
  const links: LlmsLink[] = [];
  const mcpPath = opts.mcpPath ?? "/mcp";
  const openapiPath = opts.openapiPath ?? "/openapi.json";
  const fullPath = opts.fullPath ?? "/llms-full.txt";
  if (mcpPath) {
    links.push({
      title: "MCP endpoint",
      url: joinUrl(opts.baseUrl, mcpPath),
      description: "Model Context Protocol server (Streamable HTTP, POST JSON-RPC). Every operation is a tool.",
    });
  }
  if (openapiPath) links.push({ title: "OpenAPI 3.1", url: joinUrl(opts.baseUrl, openapiPath), description: "Machine-readable API description" });
  if (fullPath && !full) {
    links.push({ title: "llms-full.txt", url: joinUrl(opts.baseUrl, fullPath), description: "Every operation with full JSON Schemas" });
  }
  return links;
}

function section(s: LlmsSection): string[] {
  return [`## ${s.title}`, "", ...s.links.map((l) => `- [${l.title}](${l.url})${l.description ? `: ${l.description}` : ""}`), ""];
}

function finish(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Generate `llms.txt`: title, summary, an API index, agent access links and custom sections. */
export function generateLlmsTxt(app: AppLike, opts: LlmsOptions = {}): string {
  const out = header(app, opts);
  const api: LlmsLink[] = documented(app).map((r) => {
    const fields = inputFields(r);
    const parts = [r.meta.summary ?? r.meta.description ?? ""];
    if (fields.length) parts.push(`Input: ${fields.map(fieldLabel).join(", ")}`);
    parts.push(`Tool: \`${toolName(r)}\``);
    const p = toOpenAPIPath(r.path);
    return {
      title: `${r.method} ${p}`,
      url: joinUrl(opts.baseUrl, p),
      description: parts.filter(Boolean).join(". ") + (r.meta.deprecated ? " (deprecated)" : ""),
    };
  });
  if (api.length) out.push(...section({ title: "API", links: api }));
  const agents = agentLinks(opts, false);
  if (agents.length) out.push(...section({ title: "Agent access", links: agents }));
  for (const s of opts.sections ?? []) out.push(...section(s));
  return finish(out);
}

const jsonBlock = (s: unknown) => ["```json", JSON.stringify(s, null, 2), "```", ""];

/** Generate `llms-full.txt`: everything in llms.txt plus per-operation JSON Schemas. */
export function generateLlmsFullTxt(app: AppLike, opts: LlmsOptions = {}): string {
  const out = header(app, opts);
  const agents = agentLinks(opts, true);
  if (agents.length) out.push(...section({ title: "Agent access", links: agents }));
  for (const r of documented(app)) {
    const m = r.meta;
    out.push(`## ${r.method} ${toOpenAPIPath(r.path)}`, "");
    if (m.summary) out.push(m.summary, "");
    if (m.description && m.description !== m.summary) out.push(m.description, "");
    const facts = [`Tool: \`${toolName(r)}\``, `URL: ${joinUrl(opts.baseUrl, toOpenAPIPath(r.path))}`];
    if (m.tags?.length) facts.push(`Tags: ${m.tags.join(", ")}`);
    if (m.deprecated) facts.push("Deprecated: yes");
    out.push(...facts.map((f) => `- ${f}`), "");
    const pathParams = pathParamNames(r.path);
    if (m.params) out.push("### Path parameters", "", ...jsonBlock(toJSONSchema(m.params)));
    else if (pathParams.length) {
      const properties = Object.fromEntries(pathParams.map((n) => [n, { type: "string" }]));
      out.push("### Path parameters", "", ...jsonBlock({ type: "object", properties, required: pathParams }));
    }
    if (m.query) out.push("### Query", "", ...jsonBlock(toJSONSchema(m.query)));
    if (m.headers) out.push("### Headers", "", ...jsonBlock(toJSONSchema(m.headers)));
    if (m.body) out.push("### Request body", "", "Content-Type: application/json", "", ...jsonBlock(toJSONSchema(m.body)));
    if (m.response) out.push("### Response", "", ...jsonBlock(toJSONSchema(m.response)));
    out.push("Errors are RFC 9457 `application/problem+json`; validation failures are 422 with an `issues` array.", "");
  }
  for (const s of opts.sections ?? []) out.push(...section(s));
  return finish(out);
}

/** Middleware serving `/llms.txt` and `/llms-full.txt`. Generated once, on first request. */
export function llms(opts: LlmsMiddlewareOptions = {}): Middleware {
  const path = opts.path ?? "/llms.txt";
  const fullPath = opts.fullPath ?? "/llms-full.txt";
  let short: string | undefined;
  let full: string | undefined;
  return async (c, next) => {
    if (c.method !== "GET" && c.method !== "HEAD") return next();
    const p = c.url.pathname;
    if (p !== path && p !== fullPath) return next();
    const gen = { ...opts, fullPath, baseUrl: opts.baseUrl ?? c.url.origin };
    const body = p === path ? (short ??= generateLlmsTxt(c.app, gen)) : (full ??= generateLlmsFullTxt(c.app, gen));
    return c.text(body);
  };
}
