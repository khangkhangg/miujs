/** Generate a `wrangler.toml` for a Miu app on Cloudflare Workers. */

export interface WranglerOptions {
  name: string;
  /** Worker entry. Default `src/worker.ts`. */
  main?: string;
  /** Defaults to today. */
  date?: Date;
  nodejsCompat?: boolean;
  /** `BINDING` or `BINDING:resource-name` entries. */
  kv?: string[];
  d1?: string[];
  r2?: string[];
  queue?: string[];
  /** `Class` or `BINDING:Class` entries. */
  do?: string[];
}

const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (s: string) => JSON.stringify(s);

function split(entry: string): [string, string | undefined] {
  const i = entry.indexOf(":");
  const binding = i < 0 ? entry : entry.slice(0, i);
  if (!BINDING.test(binding)) throw new Error(`Invalid binding name: ${JSON.stringify(binding)} (use letters, digits and _)`);
  return [binding, i < 0 ? undefined : entry.slice(i + 1)];
}

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const upperSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

export function generateWranglerToml(o: WranglerOptions): string {
  const date = (o.date ?? new Date()).toISOString().slice(0, 10);
  const resource = (binding: string, given: string | undefined) => given ?? `${kebab(o.name)}-${kebab(binding)}`;
  const out = [
    `name = ${q(o.name)}`,
    `main = ${q(o.main ?? "src/worker.ts")}`,
    `compatibility_date = ${q(date)}`,
    o.nodejsCompat ? `compatibility_flags = ["nodejs_compat"]` : `# compatibility_flags = ["nodejs_compat"]`,
    "",
    "[vars]",
    `# GREETING = "hello"`,
    "",
  ];
  for (const e of o.kv ?? []) {
    const [b] = split(e);
    out.push(`# npx wrangler kv namespace create ${b}`, "[[kv_namespaces]]", `binding = ${q(b)}`, `id = ${q(`<${b}_KV_ID>`)}`, "");
  }
  for (const e of o.d1 ?? []) {
    const [b, name] = split(e);
    out.push(`# npx wrangler d1 create ${resource(b, name)}`, "[[d1_databases]]", `binding = ${q(b)}`, `database_name = ${q(resource(b, name))}`, `database_id = ${q(`<${b}_D1_ID>`)}`, "");
  }
  for (const e of o.r2 ?? []) {
    const [b, name] = split(e);
    out.push(`# npx wrangler r2 bucket create ${resource(b, name)}`, "[[r2_buckets]]", `binding = ${q(b)}`, `bucket_name = ${q(resource(b, name))}`, "");
  }
  for (const e of o.queue ?? []) {
    const [b, name] = split(e);
    const queue = resource(b, name);
    out.push(`# npx wrangler queues create ${queue}`, "[[queues.producers]]", `binding = ${q(b)}`, `queue = ${q(queue)}`, "", "[[queues.consumers]]", `queue = ${q(queue)}`, "");
  }
  const classes: string[] = [];
  for (const e of o.do ?? []) {
    const [first, cls] = split(e);
    const className = cls ?? first;
    if (!BINDING.test(className)) throw new Error(`Invalid Durable Object class: ${JSON.stringify(className)}`);
    const binding = cls ? first : upperSnake(first);
    classes.push(className);
    out.push(`# export class ${className} from your worker entry`, "[[durable_objects.bindings]]", `name = ${q(binding)}`, `class_name = ${q(className)}`, "");
  }
  if (classes.length) {
    out.push("[[migrations]]", `tag = "v1"`, `new_sqlite_classes = [${classes.map(q).join(", ")}]`, "");
  }
  return out.join("\n").trimEnd() + "\n";
}
