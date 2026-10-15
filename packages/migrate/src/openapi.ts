// Schema import: JSON Schema (Pydantic, OpenAPI) → `t` builder source, and OpenAPI → route stubs.
// The output is TypeScript source text for a person or agent to finish, never evaluated here.

import { migrateError } from "./errors.ts";
import { NOT_PORTED_TAG } from "./proxy.ts";

type JS = Record<string, any>;

const IDENT = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await t route errors".split(" "),
);

/** A safe TypeScript identifier for a schema or operation name. */
export function toIdentifier(name: string): string {
  let s = String(name).replace(/[^A-Za-z0-9_$]/g, "_");
  if (!s) s = "_";
  if (/^\d/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s = `${s}_`;
  return s;
}

const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const lit = (v: unknown) => JSON.stringify(v);

export interface ToTOptions {
  /** Maps a `$ref` to the identifier holding its schema, or null when unknown. Default: the ref's last segment. */
  refName?: (ref: string) => string | null;
  /** Called for things that cannot be expressed exactly. */
  warn?: (message: string) => void;
  /** @internal names currently being defined (cycle detection). */
  defining?: Set<string>;
}

function opts(parts: [string, unknown][]): string {
  const p = parts.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
  return p.length ? `{ ${p.join(", ")} }` : "";
}

const FORMATS: Record<string, string> = { uuid: "uuid", email: "email", uri: "url", url: "url", date: "date", "date-time": "date-time" };

function isNull(s: unknown): boolean {
  return !!s && typeof s === "object" && ((s as JS).type === "null" || ((s as JS).enum && (s as JS).enum.length === 1 && (s as JS).enum[0] === null));
}

/** One JSON Schema → a `t` expression (source text). */
export function jsonSchemaToT(schema: unknown, o: ToTOptions = {}, indent = 0): string {
  const warn = o.warn ?? (() => {});
  const pad = " ".repeat(indent);
  if (schema === true || schema === undefined || schema === null) return "t.unknown()";
  if (schema === false) {
    warn("`false` schema (nothing allowed) mapped to t.unknown()");
    return "t.unknown()";
  }
  const s = schema as JS;
  const desc = typeof s.description === "string" ? lit(s.description) : undefined;
  const wrapNull = (e: string) => (s.nullable === true ? `t.nullable(${e})` : e);

  if (typeof s.$ref === "string") {
    const name = o.refName ? o.refName(s.$ref) : toIdentifier(s.$ref.split("/").pop() ?? "Unknown");
    if (name === null) {
      warn(`unknown $ref ${s.$ref}`);
      return "t.unknown()";
    }
    if (o.defining?.has(name)) return `t.any() /* recursive: ${name} */`;
    return wrapNull(name);
  }
  if (Array.isArray(s.allOf)) {
    if (s.allOf.length === 1) return wrapNull(jsonSchemaToT(s.allOf[0], o, indent));
    const props: JS = {};
    const required: string[] = [];
    for (const part of s.allOf) {
      if (!part || typeof part !== "object" || !part.properties) {
        warn("allOf with non-object parts mapped to t.any()");
        return "t.any()";
      }
      Object.assign(props, part.properties);
      required.push(...(part.required ?? []));
    }
    return jsonSchemaToT({ type: "object", properties: props, required, description: s.description }, o, indent);
  }
  const alts = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (alts) {
    const nullable = alts.some(isNull);
    const rest = alts.filter((a: unknown) => !isNull(a));
    let e = rest.length === 0 ? "t.unknown()" : rest.length === 1 ? jsonSchemaToT(rest[0], o, indent) : `t.union([${rest.map((a: unknown) => jsonSchemaToT(a, o, indent)).join(", ")}])`;
    if (nullable || s.nullable === true) e = `t.nullable(${e})`;
    return e;
  }
  if (Array.isArray(s.type)) {
    const types = s.type.filter((x: string) => x !== "null");
    const nullable = types.length !== s.type.length;
    const base = types.length === 1 ? jsonSchemaToT({ ...s, type: types[0] }, o, indent) : `t.union([${types.map((x: string) => jsonSchemaToT({ ...s, type: x }, o, indent)).join(", ")}])`;
    return nullable ? `t.nullable(${base})` : base;
  }
  if ("const" in s) {
    if (["string", "number", "boolean"].includes(typeof s.const)) return wrapNull(`t.literal(${lit(s.const)}${desc ? `, { description: ${desc} }` : ""})`);
    warn(`const ${lit(s.const)} mapped to t.unknown()`);
    return "t.unknown()";
  }
  if (Array.isArray(s.enum)) {
    const vals = s.enum.filter((v: unknown) => v !== null);
    if (vals.every((v: unknown) => typeof v === "string" || typeof v === "number")) {
      const e = `t.enum([${vals.map(lit).join(", ")}]${desc ? `, { description: ${desc} }` : ""})`;
      return vals.length !== s.enum.length || s.nullable === true ? `t.nullable(${e})` : e;
    }
    warn("enum with non-string/number values mapped to t.unknown()");
    return "t.unknown()";
  }
  const type = s.type ?? (s.properties ? "object" : s.items ? "array" : undefined);
  switch (type) {
    case "string": {
      if (s.format === "binary") return wrapNull("t.any() /* binary (file upload) */");
      let pattern: string | undefined;
      if (typeof s.pattern === "string") {
        try {
          new RegExp(s.pattern);
          pattern = `new RegExp(${lit(s.pattern)})`;
        } catch {
          warn(`pattern ${s.pattern} is not a valid JavaScript RegExp; dropped`);
        }
      }
      const fmt = typeof s.format === "string" && FORMATS[s.format] ? lit(FORMATS[s.format]) : undefined;
      const a = opts([["minLength", s.minLength], ["maxLength", s.maxLength], ["pattern", pattern], ["format", fmt], ["description", desc]]);
      return wrapNull(`t.string(${a})`);
    }
    case "integer":
    case "number": {
      const int = type === "integer";
      let min = s.minimum as number | undefined;
      let max = s.maximum as number | undefined;
      let note = "";
      // OpenAPI 3.1 / JSON Schema: numeric exclusive bounds. OpenAPI 3.0: boolean flags on minimum/maximum.
      const exMin = typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum : s.exclusiveMinimum === true ? s.minimum : undefined;
      const exMax = typeof s.exclusiveMaximum === "number" ? s.exclusiveMaximum : s.exclusiveMaximum === true ? s.maximum : undefined;
      if (exMin !== undefined) {
        min = int ? Math.floor(exMin) + 1 : exMin;
        if (!int) note += ` /* exclusiveMinimum ${exMin}: also reject == ${exMin} in the handler */`;
      }
      if (exMax !== undefined) {
        max = int ? Math.ceil(exMax) - 1 : exMax;
        if (!int) note += ` /* exclusiveMaximum ${exMax}: also reject == ${exMax} in the handler */`;
      }
      return wrapNull(`t.${int ? "integer" : "number"}(${opts([["min", min], ["max", max], ["description", desc]])})${note}`);
    }
    case "boolean":
      return wrapNull(`t.boolean(${opts([["description", desc]])})`);
    case "null":
      return "t.nullable(t.unknown())";
    case "array": {
      if (s.prefixItems) warn("tuple (prefixItems) mapped to an array of t.unknown()");
      const item = s.prefixItems ? "t.unknown()" : jsonSchemaToT(s.items, o, indent);
      const a = opts([["min", s.minItems], ["max", s.maxItems], ["description", desc]]);
      return wrapNull(`t.array(${item}${a ? `, ${a}` : ""})`);
    }
    case "object": {
      const props = s.properties && typeof s.properties === "object" ? Object.entries(s.properties as JS) : [];
      if (props.length === 0) {
        const ap = s.additionalProperties;
        const inner = ap && typeof ap === "object" ? jsonSchemaToT(ap, o, indent) : "t.unknown()";
        return wrapNull(`t.record(${inner}${desc ? `, { description: ${desc} }` : ""})`);
      }
      const required = new Set<string>(s.required ?? []);
      const lines = props.map(([k, v]) => {
        let e = jsonSchemaToT(v, o, indent + 2);
        if (!required.has(k)) {
          const d = v && typeof v === "object" ? (v as JS).default : undefined;
          e = d !== undefined && (d === null || ["string", "number", "boolean"].includes(typeof d) || typeof d === "object") ? `t.default(${e}, ${lit(d)})` : `t.optional(${e})`;
        }
        return `${pad}  ${key(k)}: ${e},`;
      });
      return wrapNull(`t.object({\n${lines.join("\n")}\n${pad}}${desc ? `, { description: ${desc} }` : ""})`);
    }
    default:
      return "t.unknown()";
  }
}

/** Every $ref inside a schema. */
function refsIn(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const x of schema) refsIn(x, out);
  else if (schema && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$ref" && typeof v === "string") out.add(v);
      else refsIn(v, out);
    }
  }
  return out;
}

/** Emits `export const Name = ...` for each named schema reachable from `roots`, dependencies first. */
function emitDefs(defs: Record<string, unknown>, roots: string[], refToDef: (ref: string) => string | null, warn: (m: string) => void): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const stack = new Set<string>();
  const nameOf = (def: string) => toIdentifier(def);
  const refName = (ref: string) => {
    const d = refToDef(ref);
    return d !== null && d in defs ? nameOf(d) : null;
  };
  const visit = (def: string) => {
    if (done.has(def) || stack.has(def)) return;
    stack.add(def);
    for (const r of refsIn(defs[def])) {
      const d = refToDef(r);
      if (d !== null && d in defs) visit(d);
    }
    const defining = new Set([...stack].map(nameOf));
    const id = nameOf(def);
    out.push(`export const ${id} = ${jsonSchemaToT(defs[def], { refName, warn, defining })};\nexport type ${id} = Infer<typeof ${id}>;`);
    stack.delete(def);
    done.add(def);
  };
  for (const r of roots) visit(r);
  return out;
}

function defName(ref: string): string | null {
  const m = /^#\/(?:\$defs|definitions|components\/schemas)\/(.+)$/.exec(ref);
  return m ? m[1].replace(/~1/g, "/").replace(/~0/g, "~") : null;
}

/** A Pydantic `Model.model_json_schema()` (any JSON Schema) → a module exporting `t` schemas and types. */
export function pydanticToT(schema: JS, opt: { name?: string; warn?: (m: string) => void } = {}): string {
  const warn = opt.warn ?? (() => {});
  const defs: Record<string, unknown> = { ...(schema.$defs ?? {}), ...(schema.definitions ?? {}) };
  const rootName = opt.name ?? (typeof schema.title === "string" ? schema.title : "Model");
  const { $defs: _a, definitions: _b, ...root } = schema;
  const all = { ...defs, [rootName]: root };
  const body = emitDefs(all, [...Object.keys(defs), rootName], defName, warn);
  return `// Generated by @miujs/migrate (pydanticToT). Review constraints marked in comments.\nimport { t, type Infer } from "miujs";\n\n${body.join("\n\n")}\n`;
}

// --- OpenAPI → route stubs -------------------------------------------------------------------

export interface GeneratedFile {
  path: string;
  source: string;
}

export interface FromOpenApiResult {
  files: GeneratedFile[];
  routes: { method: string; path: string; name: string; file: string }[];
  warnings: string[];
}

/** Route tag for generated stubs; migrateProxy forwards tagged routes to the old app. */
export const NOT_PORTED = NOT_PORTED_TAG;

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/**
 * An OpenAPI 3.x document (FastAPI's /openapi.json, Laravel Scribe/Scramble, drf-spectacular)
 * → route stubs with `t` schemas for params, query, body and response. Each handler throws
 * MIU_E_MIGRATE_NOT_PORTED (501) until it is written.
 */
export function fromOpenApi(spec: JS, opt: { /** Folder for route files. Default "routes". */ dir?: string } = {}): FromOpenApiResult {
  if (!spec || typeof spec !== "object" || typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.") || typeof spec.paths !== "object") {
    throw migrateError(
      "OPENAPI",
      400,
      "Not an OpenAPI 3.x document",
      "Pass the parsed JSON of an OpenAPI 3.0/3.1 spec (FastAPI serves /openapi.json). Convert Swagger 2.0 first, e.g. with swagger2openapi.",
    );
  }
  const dir = (opt.dir ?? "routes").replace(/\/+$/, "");
  const warnings: string[] = [];
  const components: Record<string, unknown> = spec.components?.schemas ?? {};
  const used = new Set<string>();
  const refName = (ref: string) => {
    const d = defName(ref);
    if (d === null || !(d in components)) return null;
    used.add(d);
    return toIdentifier(d);
  };
  const groups = new Map<string, { file: string; blocks: string[]; imports: Set<string> }>();
  const routes: FromOpenApiResult["routes"] = [];
  const names = new Set<string>();
  const globalSecurity = spec.security;

  for (const [rawPath, item] of Object.entries(spec.paths as Record<string, JS>)) {
    const shared: JS[] = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method] as JS | undefined;
      if (!op) continue;
      const warn = (m: string) => warnings.push(`${method.toUpperCase()} ${rawPath}: ${m}`);
      const o: ToTOptions = { refName, warn };
      const path = rawPath.replace(/\{([^}]+)\}/g, (_m, n) => `:${toIdentifier(n)}`);
      const segs = rawPath.split("/").filter((x) => x && !x.startsWith("{"));
      const group = toIdentifier(segs[0] ?? "root");
      const file = `${dir}/${group}.ts`;
      let name = toIdentifier(op.operationId ?? [method, ...rawPath.split("/").filter(Boolean).map((x) => x.replace(/[{}]/g, ""))].join("_") + (rawPath === "/" ? "_root" : ""));
      while (names.has(name)) name += "_";
      names.add(name);

      const params = [...shared, ...(op.parameters ?? [])].map((p) => (p.$ref ? resolveParam(spec, p.$ref) : p)).filter(Boolean) as JS[];
      const pathParams = [...rawPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const lines: string[] = [];
      if (op.summary) lines.push(`  summary: ${lit(op.summary)},`);
      if (op.description) lines.push(`  description: ${lit(op.description)},`);
      // "not-ported": migrateProxy keeps sending this route to the old app until the tag is removed.
      lines.push(`  tags: ${lit([NOT_PORTED, ...(op.tags ?? [])])},`);
      if (pathParams.length) {
        const props = pathParams.map((n) => `    ${key(toIdentifier(n))}: ${jsonSchemaToT(params.find((p) => p.in === "path" && p.name === n)?.schema ?? { type: "string" }, o, 4)},`);
        lines.push(`  params: t.object({\n${props.join("\n")}\n  }),`);
      }
      const query = params.filter((p) => p.in === "query");
      if (query.length) {
        const props = query.map((p) => {
          let e = jsonSchemaToT(p.schema ?? { type: "string" }, o, 4);
          if (!p.required) e = p.schema?.default !== undefined ? `t.default(${e}, ${lit(p.schema.default)})` : `t.optional(${e})`;
          return `    ${key(p.name)}: ${e},`;
        });
        lines.push(`  query: t.object({\n${props.join("\n")}\n  }),`);
      }
      for (const p of params.filter((p) => p.in === "header" || p.in === "cookie")) {
        lines.push(`  // Not validated here: ${p.in} ${p.name}${p.required ? " (required)" : ""}. Read it from ctx.${p.in === "header" ? "headers" : "cookies"}.`);
      }
      const content = op.requestBody?.content as JS | undefined;
      if (content) {
        const type = Object.keys(content).find((c) => c.includes("json")) ?? Object.keys(content)[0];
        let e = jsonSchemaToT(content[type]?.schema, o, 2);
        if (!op.requestBody.required) e = `t.optional(${e})`;
        if (!type.includes("json")) lines.push(`  // Request body is ${type}; MiuJS parses it into an object (files arrive as File).`);
        lines.push(`  body: ${e},`);
      }
      const codes = Object.keys(op.responses ?? {}).filter((c) => /^2\d\d$/.test(c)).sort();
      const ok = codes[0];
      if (ok && ok !== "200") lines.push(`  status: ${Number(ok)},`);
      const resContent = ok ? (op.responses[ok].content as JS | undefined) : undefined;
      const resSchema = resContent ? (resContent["application/json"] ?? Object.values(resContent).find(Boolean))?.schema : undefined;
      if (resSchema) lines.push(`  response: ${jsonSchemaToT(resSchema, o, 2)},`);
      const security = (op.security ?? globalSecurity) as JS[] | undefined;
      if (Array.isArray(security) && security.length && !security.some((s) => Object.keys(s).length === 0)) {
        lines.push(`  auth: "required", // was: ${security.map((s) => Object.keys(s).join("+")).join(" or ")}`);
      }
      lines.push(`  handler: async (ctx) => {\n    throw notPorted(${lit(`${method.toUpperCase()} ${path}`)});\n  },`);

      const doc = op.summary ? `/** ${String(op.summary).replace(/\*\//g, "* /")} */\n` : "";
      const block = `${doc}export const ${name} = route.${method}(${lit(path)}, {\n${lines.join("\n")}\n});`;
      let g = groups.get(group);
      if (!g) groups.set(group, (g = { file, blocks: [], imports: new Set() }));
      g.blocks.push(block);
      for (const r of refsIn(op)) {
        const d = defName(r);
        if (d !== null && d in components && block.includes(toIdentifier(d))) g.imports.add(toIdentifier(d));
      }
      routes.push({ method: method.toUpperCase(), path, name, file });
    }
  }

  const files: GeneratedFile[] = [];
  const title = `${spec.info?.title ?? "API"} ${spec.info?.version ?? ""}`.trim();
  if (used.size) {
    const defs = emitDefs(components, [...used], defName, (m) => warnings.push(`schema: ${m}`));
    files.push({ path: "schemas.ts", source: `// Generated by @miujs/migrate from ${title}.\nimport { t, type Infer } from "miujs";\n\n${defs.join("\n\n")}\n` });
  }
  const depth = dir.split("/").filter(Boolean).length;
  const up = depth ? "../".repeat(depth) : "./";
  for (const [, g] of groups) {
    const imports = g.imports.size ? `import { ${[...g.imports].sort().join(", ")} } from "${up}schemas.ts";\n` : "";
    files.push({
      path: g.file,
      source:
        `// Generated by @miujs/migrate from ${title}. Port one handler at a time: write the\n` +
        `// handler, then remove its "not-ported" tag. Until then migrateProxy sends the route to the\n` +
        `// old app (without the proxy, stubs answer 501).\n` +
        `import { errors, route, t } from "miujs";\n${imports}\n` +
        `const notPorted = (op: string) =>\n  errors.custom({\n    code: "MIU_E_MIGRATE_NOT_PORTED",\n    status: 501,\n    message: \`\${op} is not ported yet\`,\n    fix: ${lit(`Write the handler in ${g.file} (it is still a generated stub) and remove its "not-ported" tag, or run the app behind migrateProxy so the old app keeps serving it.`)},\n  });\n\n` +
        `${g.blocks.join("\n\n")}\n`,
    });
  }
  files.push({ path: `${dir}/index.ts`, source: [...groups.values()].map((g) => `export * from "./${g.file.slice(dir.length + 1)}";`).join("\n") + "\n" });
  return { files, routes, warnings };
}

function resolveParam(spec: JS, ref: string): JS | null {
  const m = /^#\/components\/parameters\/(.+)$/.exec(ref);
  return m ? (spec.components?.parameters?.[m[1]] ?? null) : null;
}
