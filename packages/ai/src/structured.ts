import type { Issue, JsonSchema } from "miujs";

const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const DROP = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "pattern", "maxItems", "examples"];

/**
 * A JSON schema a strict structured-output mode accepts: every object closed
 * (`additionalProperties: false`), no numeric/length constraints (they are still checked
 * client-side by the `t` schema). Returns `null` when the schema needs something such modes
 * cannot express (e.g. `t.record`'s open objects).
 */
export function closedSchema(json: JsonSchema): JsonSchema | null {
  if (json.additionalProperties !== undefined && json.additionalProperties !== false) return null;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(json)) {
    if (DROP.includes(k)) continue;
    if (k === "minItems" && typeof v === "number" && v > 1) continue;
    if (k === "format") {
      const f = v === "url" ? "uri" : v;
      if (FORMATS.has(f as string)) out.format = f;
      continue;
    }
    out[k] = v;
  }
  if (json.properties && typeof json.properties === "object") {
    const props: JsonSchema = {};
    for (const [k, v] of Object.entries(json.properties as Record<string, JsonSchema>)) {
      const c = closedSchema(v);
      if (!c) return null;
      props[k] = c;
    }
    out.properties = props;
  }
  if (json.type === "object") out.additionalProperties = false;
  if (json.items && typeof json.items === "object") {
    const c = closedSchema(json.items as JsonSchema);
    if (!c) return null;
    out.items = c;
  }
  if (Array.isArray(json.anyOf)) {
    const xs = (json.anyOf as JsonSchema[]).map(closedSchema);
    if (xs.some((x) => !x)) return null;
    out.anyOf = xs;
  }
  return out;
}

/** Parses model output as JSON, tolerating a Markdown code fence around it. */
export function parseJsonOutput(text: string): { ok: true; value: unknown } | { ok: false; issues: Issue[] } {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return { ok: true, value: JSON.parse(fenced ? fenced[1] : trimmed) };
  } catch {
    return { ok: false, issues: [{ path: "", message: "is not valid JSON" }] };
  }
}

export function feedback(issues: Issue[]): string {
  return [
    "Your previous reply did not match the required JSON schema:",
    ...issues.slice(0, 20).map((i) => `- ${i.path || "(root)"} ${i.message}`),
    "Reply again with only the corrected JSON.",
  ].join("\n");
}
