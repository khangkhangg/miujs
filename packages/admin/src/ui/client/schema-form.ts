// JSON Schema (as made by `t`) → simple form fields, and form strings → typed values. Used for
// workflow action params and record action inputs. Self-contained (see filters.ts).

export interface SchemaField {
  /** Property name; "" when the whole value is one JSON field. */
  name: string;
  kind: "text" | "integer" | "number" | "boolean" | "enum" | "json";
  required: boolean;
  options?: string[];
  format?: string;
  description?: string;
}

export type SchemaFormLib = ReturnType<typeof schemaFormLib>;

export function schemaFormLib() {
  function kindOf(s: any): Pick<SchemaField, "kind" | "options" | "format"> {
    if (!s || typeof s !== "object") return { kind: "json" };
    if (Array.isArray(s.anyOf)) {
      const rest = s.anyOf.filter((x: any) => !(x && x.type === "null"));
      return rest.length === 1 ? kindOf(rest[0]) : { kind: "json" };
    }
    if (Array.isArray(s.enum) && s.enum.every((x: unknown) => typeof x === "string")) return { kind: "enum", options: s.enum.slice() };
    if (s.type === "string") return s.format ? { kind: "text", format: s.format } : { kind: "text" };
    if (s.type === "integer") return { kind: "integer" };
    if (s.type === "number") return { kind: "number" };
    if (s.type === "boolean") return { kind: "boolean" };
    return { kind: "json" };
  }

  function fields(schema: any): SchemaField[] {
    if (!schema || typeof schema !== "object") return [];
    if (schema.type !== "object" || !schema.properties) return [{ name: "", kind: "json", required: false }];
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    return Object.keys(schema.properties).map((name) => {
      const s = schema.properties[name];
      const f: SchemaField = Object.assign({ name }, kindOf(s), { required: required.indexOf(name) >= 0 }) as SchemaField;
      const ordered: SchemaField = { name: f.name, kind: f.kind, required: f.required };
      if (f.options) ordered.options = f.options;
      if (f.format) ordered.format = f.format;
      if (s && typeof s.description === "string") ordered.description = s.description;
      return ordered;
    });
  }

  const isTemplate = (s: string) => /\{\{[\s\S]*\}\}/.test(s);

  /** Form strings → an object for the schema. Empty strings are left out. */
  function coerce(list: SchemaField[], values: Record<string, string | undefined>): { value: Record<string, unknown>; errors: { name: string; message: string }[] } {
    const value: Record<string, unknown> = {};
    const errors: { name: string; message: string }[] = [];
    for (const f of list) {
      const raw = Object.prototype.hasOwnProperty.call(values, f.name) ? values[f.name] : undefined;
      if (raw === undefined || raw === null || raw === "") continue;
      if (isTemplate(raw)) {
        value[f.name] = raw;
        continue;
      }
      if (f.kind === "integer" || f.kind === "number") {
        const n = Number(raw.trim());
        if (raw.trim() === "" || !isFinite(n)) errors.push({ name: f.name, message: "must be a number" });
        else if (f.kind === "integer" && Math.floor(n) !== n) errors.push({ name: f.name, message: "must be a whole number" });
        else value[f.name] = n;
      } else if (f.kind === "boolean") value[f.name] = raw === "true" || raw === "on";
      else if (f.kind === "json") {
        try {
          value[f.name] = JSON.parse(raw);
        } catch {
          value[f.name] = raw;
        }
      } else value[f.name] = raw;
    }
    return { value, errors };
  }

  function toForm(list: SchemaField[], value: Record<string, unknown> | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!value || typeof value !== "object") return out;
    for (const f of list) {
      if (!Object.prototype.hasOwnProperty.call(value, f.name)) continue;
      const v = value[f.name];
      if (v === undefined || v === null) continue;
      out[f.name] = typeof v === "string" ? v : f.kind === "json" ? JSON.stringify(v) : String(v);
    }
    return out;
  }

  return { fields, coerce, toForm };
}
