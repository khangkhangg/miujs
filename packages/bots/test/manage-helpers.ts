import { miu, route, validate, type Context, type ManageAction, type ManageList, type ManageSection, type ManageStat, type Plugin } from "miujs";

/** A real request context from an app running `plugin`, for calling manage() sections. */
export async function manageCtx(plugin: Plugin, env: Record<string, unknown> = {}, runtime: "bun" | "workerd" = "bun"): Promise<Context> {
  let captured: Context | undefined;
  // Exempt from bot handling, so it is never cached or blocked (it still counts as one visitor).
  const r = route.get("/__manage_ctx", {
    bots: false,
    handler: (ctx) => {
      captured = ctx;
      return "ok";
    },
  });
  const app = miu({ routes: [r], plugins: [plugin], logLevel: "silent" });
  await app.ready();
  await app.dispatch(new Request("http://localhost/__manage_ctx"), env, { runtime });
  if (!captured) throw new Error("route did not run");
  return captured;
}

export function section(plugin: Plugin, id: string): ManageSection {
  const s = plugin.manage?.().find((x) => x.id === id);
  if (!s) throw new Error(`no manage section ${id}`);
  return s;
}

export function actionOf(s: { actions?: ManageAction[]; rowActions?: ManageAction[] }, name: string): ManageAction {
  const a = [...(s.actions ?? []), ...(s.rowActions ?? [])].find((x) => x.name === name);
  if (!a) throw new Error(`no action ${name}`);
  return a;
}

export function listOf(s: ManageSection, name: string): ManageList {
  const l = s.lists?.find((x) => x.name === name);
  if (!l) throw new Error(`no list ${name}`);
  return l;
}

/** Validates `input` like the admin does, then runs the action. */
export async function run(a: ManageAction, input: unknown, ctx: Context): Promise<unknown> {
  const parsed = a.input ? validate(a.input, input) : { ok: true as const, value: input };
  if (!parsed.ok) throw new Error(`invalid input: ${JSON.stringify(parsed.issues)}`);
  return a.run(parsed.value, ctx);
}

/** Checks the static shape rules of the contract. */
export function checkContract(sections: ManageSection[]): void {
  const ids = new Set<string>();
  for (const s of sections) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.id)) throw new Error(`bad section id ${s.id}`);
    if (ids.has(s.id)) throw new Error(`duplicate section id ${s.id}`);
    ids.add(s.id);
    const actions = [...(s.actions ?? []), ...(s.lists ?? []).flatMap((l) => l.rowActions ?? [])];
    for (const a of actions) if (!/^[a-z][a-zA-Z0-9_]*$/.test(a.name)) throw new Error(`bad action name ${a.name}`);
  }
}

/** The stat with this label. */
export const stat = (stats: ManageStat[] | undefined, label: string): ManageStat | undefined => stats?.find((s) => s.label === label);
