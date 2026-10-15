/** `?a=1&b=2` → `{ a: "1", b: "2" }` (first value wins). */
export function parseQueryObject(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) if (!(k in out)) out[k] = v;
  return out;
}
