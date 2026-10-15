// Workflow screens: list, builder (vertical step editor, enhanced by the client script, with a
// JSON form as the no-JS fallback), versions, runs and the run step timeline.

import { errors, type Context } from "miujs";
import { html, raw, type HtmlString } from "@miujs/web";
import { describeActions, validateSpec, type WorkflowSpec } from "@miujs/workflows";
import { workflowLib } from "./client/workflow.ts";
import { pageData, type Core, type PageData } from "./core.ts";
import { can, redirect, sub } from "./http.ts";
import { alert, page } from "./layout.ts";
import { errorPage } from "./pages.ts";

const W = workflowLib();
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const fmtTime = (ms: unknown) => (typeof ms === "number" && ms > 0 ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—");
function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}
const status = (s: string) => html`<span class="status ${s}">${s}</span>`;

async function guard(core: Core, ctx: Context, perm: "workflows:read" | "workflows:manage"): Promise<{ d: PageData } | Response> {
  const d = await pageData(core, ctx);
  if (!core.workflows) return errorPage(core, ctx, d, 404, "Not found", "Workflows are not enabled. Add workflows() from @miujs/workflows to the app.", "workflows");
  if (!can(ctx, perm)) return errorPage(core, ctx, d, 403, "Not allowed", `You need the "${perm}" permission.`, "workflows");
  return { d };
}

export async function workflowList(core: Core, ctx: Context): Promise<Response> {
  const g = await guard(core, ctx, "workflows:read");
  if (g instanceof Response) return g;
  const store = await core.store(ctx);
  const saved = await store.list();
  const listed = await sub(core.app, ctx, "GET", core.wfPrefix);
  const all: { name: string; description?: string }[] = listed.ok && Array.isArray(listed.data?.workflows) ? listed.data.workflows : [];
  const code = all.filter((w) => !core.loader?.owns(w.name) && !saved.some((s) => s.name === w.name));
  const manage = can(ctx, "workflows:manage");
  const p = core.path;
  const body = html`<div class="page-head"><h1>Workflows</h1><div class="toolbar">${manage ? html`<a class="btn primary" href="${p}/workflows/new">New workflow</a>` : ""}</div></div>
<div class="table-wrap"><table><caption class="sr-only">Workflows built here</caption><thead><tr><th scope="col">Name</th><th scope="col">Description</th><th scope="col">Latest</th><th scope="col">Published</th><th scope="col">Runs</th></tr></thead><tbody>${
    saved.length
      ? saved.map(
          (w) =>
            html`<tr><td><a href="${p}/workflows/edit/${encodeURIComponent(w.name)}">${w.name}</a></td><td>${w.description ?? ""}</td><td>v${w.latest}</td><td>${w.published ? html`<span class="status completed">v${w.published}</span>` : html`<span class="status cancelled">not published</span>`}</td><td><a href="${p}/workflows/runs/${encodeURIComponent(w.name)}">Runs</a></td></tr>`,
        )
      : html`<tr><td colspan="5" class="muted">No workflows yet.</td></tr>`
  }</tbody></table></div>${
    code.length
      ? html`<h2>Defined in code</h2><p class="help">These are part of the app's source and cannot be edited here.</p><ul>${code.map((w) => html`<li>${w.name}${w.description ? html` — ${w.description}` : ""} · <a href="${p}/workflows/runs/${encodeURIComponent(w.name)}">Runs</a></li>`)}</ul>`
      : ""
  }`;
  return page(core.shell, ctx, { title: "Workflows", active: "workflows", body, ...g.d });
}

function issueList(issues: { path: string; message: string; fix: string }[], spec: unknown): HtmlString | string {
  if (!issues.length) return "";
  const by = W.issuesByStep(issues);
  const stepName = (path: string) => {
    if (!path) return "Workflow";
    const s = spec && typeof spec === "object" ? W.get(spec as never, path) : undefined;
    return `Step ${s && typeof s.id === "string" ? s.id : path}`;
  };
  return html`<div class="alert" role="alert"><p>${issues.length} problem${issues.length === 1 ? "" : "s"}:</p><ul>${Object.entries(by).map(([path, list]) =>
    list.map((i) => html`<li data-issue-path="${path}"><strong>${stepName(path)}</strong>${i.field ? html` · ${i.field}` : ""}: ${i.message}. ${i.fix}</li>`),
  )}</ul></div>`;
}

async function editor(core: Core, ctx: Context, d: PageData, name: string | null, o: { spec?: unknown; issues?: { path: string; message: string; fix: string }[]; status?: number; json?: string } = {}): Promise<Response> {
  const store = await core.store(ctx);
  const p = core.path;
  const stored = name ? await store.get(name, Number(ctx.url.searchParams.get("version")) || undefined) : null;
  if (name && !stored && !o.spec) return errorPage(core, ctx, d, 404, "Not found", `There is no workflow "${name}" here.`, "workflows");
  const spec = o.spec ?? stored?.spec ?? { name: "", trigger: { type: "manual" }, steps: [] };
  const versions = name ? await store.versions(name) : [];
  const manage = can(ctx, "workflows:manage");
  const all = core.admin.schema();
  const events = W.resourceEvents(all.resources.map((r) => r.name));
  const fields = Object.fromEntries(all.resources.map((r) => [r.name, r.fields.map((f) => f.name)]));
  const actions = describeActions(core.actions());
  const json = o.json ?? JSON.stringify(spec, null, 2);
  const body = html`<div class="page-head"><h1>${name ? html`Workflow ${name}` : "New workflow"}</h1><div class="toolbar">${name ? html`<a class="btn" href="${p}/workflows/runs/${encodeURIComponent(name)}">Runs</a>` : ""}<a class="btn" href="${p}/workflows">All workflows</a></div></div>
${issueList(o.issues ?? [], spec)}${ctx.url.searchParams.get("done") === "saved" ? alert("Saved.", "ok") : ""}${ctx.url.searchParams.get("done") === "published" ? alert("Published.", "ok") : ""}
<div data-workflow-builder data-spec="${JSON.stringify(spec)}" data-actions="${JSON.stringify(actions)}" data-events="${JSON.stringify(events)}" data-fields="${JSON.stringify(fields)}" data-save-url="${p}/api/workflows" data-validate-url="${p}/api/workflows/validate" data-publish-url="${p}/api/workflows/:name/publish" data-edit-url="${p}/workflows/edit/:name" data-can-edit="${manage ? "true" : "false"}" data-existing="${name ? "true" : "false"}">
<div data-builder-root></div>
${manage ? html`<div class="toolbar"><button type="button" data-validate>Validate</button><button type="button" class="primary" data-save>Save draft</button><button type="button" data-publish>Save and publish</button></div>` : ""}
<p data-builder-status role="status" aria-live="polite"></p>
</div>
<details class="panel"><summary>Edit as JSON</summary><form method="post" action="${p}/workflows/save"><div class="field"><label for="wf-json">Workflow spec (JSON)</label><textarea id="wf-json" name="json" rows="16" class="mono"${manage ? "" : raw(" readonly")}>${json}</textarea></div>${
    manage ? html`<div class="toolbar"><button type="submit" name="publish" value="" class="primary">Save draft</button><button type="submit" name="publish" value="1">Save and publish</button></div>` : ""
  }</form></details>
${
  versions.length
    ? html`<section class="panel" aria-labelledby="versions-h"><h2 id="versions-h">Versions</h2><div class="table-wrap"><table><thead><tr><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Saved</th><th scope="col">By</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${versions.map(
        (v) =>
          html`<tr><td><a href="${p}/workflows/edit/${encodeURIComponent(v.name)}?version=${v.version}">v${v.version}</a></td><td>${v.status === "published" ? html`<span class="status completed">published</span>` : html`<span class="badge">${v.status}</span>`}</td><td>${fmtTime(v.createdAt)}</td><td>${v.createdBy ?? "—"}</td><td>${
            manage && v.status !== "published"
              ? html`<form method="post" action="${p}/workflows/publish/${encodeURIComponent(v.name)}"><input type="hidden" name="version" value="${v.version}"><button type="submit">Publish v${v.version}</button></form>`
              : manage
                ? html`<form method="post" action="${p}/workflows/unpublish/${encodeURIComponent(v.name)}"><button type="submit">Unpublish</button></form>`
                : ""
          }</td></tr>`,
      )}</tbody></table></div></section>`
    : ""
}`;
  return page(core.shell, ctx, { title: name ? `Workflow ${name}` : "New workflow", active: "workflows", body, status: o.status, ...d });
}

export async function workflowEditor(core: Core, ctx: Context, name: string | null): Promise<Response> {
  const g = await guard(core, ctx, "workflows:read");
  if (g instanceof Response) return g;
  if (!name && !can(ctx, "workflows:manage")) return errorPage(core, ctx, g.d, 403, "Not allowed", 'You need the "workflows:manage" permission.', "workflows");
  return editor(core, ctx, g.d, name);
}

type SaveResult = { ok: true; name: string; version: number } | { ok: false; status: number; issues: { path: string; message: string; fix: string }[]; message?: string };

async function saveSpec(core: Core, ctx: Context, spec: unknown): Promise<SaveResult> {
  const checked = validateSpec(spec, { actions: core.actions() });
  if (!checked.ok) return { ok: false, status: 400, issues: checked.issues };
  const s = checked.spec as WorkflowSpec;
  const store = await core.store(ctx);
  if (core.workflows!.has(s.name) && !core.loader?.owns(s.name) && !(await store.get(s.name))) {
    return { ok: false, status: 409, issues: [{ path: "name", message: `"${s.name}" is already used by a workflow defined in code`, fix: "Choose another name." }] };
  }
  const saved = await store.save(s, ctx.user?.id ?? null);
  return { ok: true, name: saved.name, version: saved.version };
}

async function publish(core: Core, ctx: Context, name: string, version: number): Promise<{ ok: boolean; status: number; message?: string }> {
  const store = await core.store(ctx);
  const target = await store.get(name, version);
  if (!target) return { ok: false, status: 404, message: `Workflow ${name} v${version} does not exist.` };
  // Re-check against today's actions before it goes live.
  const checked = validateSpec(target.spec, { actions: core.actions() });
  if (!checked.ok) return { ok: false, status: 400, message: checked.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
  await store.publish(name, version, ctx.user?.id ?? null);
  if (core.loader) {
    const report = await core.loader.sync(store);
    const err = report.errors.find((e) => e.name === name);
    if (err) {
      await store.unpublish(name);
      await core.loader.sync(store);
      return { ok: false, status: 409, message: err.message };
    }
  }
  return { ok: true, status: 200 };
}

// Form routes (no JavaScript needed).

export async function saveForm(core: Core, ctx: Context): Promise<Response> {
  const g = await guard(core, ctx, "workflows:manage");
  if (g instanceof Response) return g;
  const form = (ctx.body ?? {}) as Record<string, unknown>;
  const text = typeof form.json === "string" ? form.json : "";
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    return editor(core, ctx, g.d, null, { issues: [{ path: "", message: `The JSON could not be read (${(err as Error).message})`, fix: "Check commas, quotes and brackets." }], status: 400, json: text, spec: { name: "", trigger: { type: "manual" }, steps: [] } });
  }
  const res = await saveSpec(core, ctx, spec);
  const existing = spec && typeof spec === "object" && typeof (spec as { name?: unknown }).name === "string" && NAME.test((spec as { name: string }).name) ? (spec as { name: string }).name : null;
  if (!res.ok) return editor(core, ctx, g.d, existing && (await (await core.store(ctx)).get(existing)) ? existing : null, { spec, issues: res.issues, status: res.status, json: text });
  if (form.publish === "1") {
    const pub = await publish(core, ctx, res.name, res.version);
    if (!pub.ok) return errorPage(core, ctx, g.d, pub.status, "Not published", pub.message ?? "", "workflows");
    return redirect(`${core.path}/workflows/edit/${encodeURIComponent(res.name)}?done=published`);
  }
  return redirect(`${core.path}/workflows/edit/${encodeURIComponent(res.name)}?done=saved`);
}

export async function publishForm(core: Core, ctx: Context, name: string, unpublish: boolean): Promise<Response> {
  const g = await guard(core, ctx, "workflows:manage");
  if (g instanceof Response) return g;
  if (unpublish) {
    const store = await core.store(ctx);
    await store.unpublish(name);
    await core.loader?.sync(store);
    return redirect(`${core.path}/workflows/edit/${encodeURIComponent(name)}?done=saved`);
  }
  const version = Number((ctx.body as Record<string, unknown> | undefined)?.version);
  const res = await publish(core, ctx, name, Number.isInteger(version) ? version : 0);
  if (!res.ok) return errorPage(core, ctx, g.d, res.status, "Not published", res.message ?? "", "workflows");
  return redirect(`${core.path}/workflows/edit/${encodeURIComponent(name)}?done=published`);
}

// JSON routes for the builder script.

function need(ctx: Context, core: Core, perm: string): void {
  if (!core.workflows) throw errors.custom({ code: "MIU_E_ADMIN_WORKFLOWS_MISSING", status: 404, message: "Workflows are not enabled", fix: "Add workflows() from @miujs/workflows to the app." });
  if (!can(ctx, perm)) throw errors.forbidden(`Missing permission "${perm}"`, `Grant "${perm}" to this user's role.`);
}

export async function apiValidate(core: Core, ctx: Context, spec: unknown) {
  need(ctx, core, "workflows:read");
  const r = validateSpec(spec, { actions: core.actions() });
  return r.ok ? { ok: true, issues: [] } : { ok: false, issues: r.issues };
}

export async function apiSave(core: Core, ctx: Context, spec: unknown) {
  need(ctx, core, "workflows:manage");
  const r = await saveSpec(core, ctx, spec);
  if (!r.ok) {
    throw errors.custom({
      code: r.status === 409 ? "MIU_E_ADMIN_WORKFLOW_NAME_TAKEN" : "MIU_E_WORKFLOW_SPEC_INVALID",
      status: r.status,
      message: `The workflow has ${r.issues.length} problem(s)`,
      fix: "Fix the issues listed in details.issues (each has a path and a fix), then save again.",
      details: { issues: r.issues },
    });
  }
  return { name: r.name, version: r.version, status: "draft", url: `${core.path}/workflows/edit/${encodeURIComponent(r.name)}` };
}

export async function apiPublish(core: Core, ctx: Context, name: string, version: number | null) {
  need(ctx, core, "workflows:manage");
  if (version === null) {
    const store = await core.store(ctx);
    await store.unpublish(name);
    await core.loader?.sync(store);
    return { name, published: null };
  }
  const r = await publish(core, ctx, name, version);
  if (!r.ok) throw errors.custom({ code: "MIU_E_ADMIN_WORKFLOW_PUBLISH", status: r.status, message: r.message ?? "Not published", fix: "Fix the workflow and save a new version, then publish it." });
  return { name, published: version };
}

// Runs.

export async function runsPage(core: Core, ctx: Context, name: string): Promise<Response> {
  const g = await guard(core, ctx, "workflows:read");
  if (g instanceof Response) return g;
  const qs = new URLSearchParams({ workflow: name, limit: "50" });
  const st = ctx.url.searchParams.get("status");
  if (st && /^[a-z]+$/.test(st)) qs.set("status", st);
  const before = ctx.url.searchParams.get("before");
  if (before && /^\d+$/.test(before)) qs.set("before", before);
  const res = await sub(core.app, ctx, "GET", `${core.wfPrefix}/runs?${qs}`);
  const p = core.path;
  const runs: any[] = res.ok ? res.data.runs : [];
  const body = html`<div class="page-head"><h1>Runs of ${name}</h1><div class="toolbar"><a class="btn" href="${p}/workflows">All workflows</a></div></div>${res.ok ? "" : alert(res.data?.error?.message ?? "Could not load runs.")}
<div class="table-wrap"><table><caption class="sr-only">Runs, newest first</caption><thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Trigger</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Error</th></tr></thead><tbody>${
    runs.length
      ? runs.map(
          (r) =>
            html`<tr><td><a href="${p}/workflows/run/${encodeURIComponent(r.id)}">${String(r.id).slice(0, 8)}</a></td><td>${status(String(r.status))}</td><td>${r.trigger?.type ?? ""}${r.trigger?.event ? html` · ${r.trigger.event}` : ""}</td><td>${fmtTime(r.createdAt)}</td><td>${fmtDuration(
              r.finishedAt ? r.finishedAt - r.createdAt : null,
            )}</td><td>${r.error ? html`${r.error.step ? html`<strong>${r.error.step}</strong>: ` : ""}${r.error.message}` : ""}</td></tr>`,
        )
      : html`<tr><td colspan="6" class="muted">No runs yet.</td></tr>`
  }</tbody></table></div>${res.ok && res.data.next ? html`<nav class="pager" aria-label="Pages"><a class="btn" rel="next" href="${p}/workflows/runs/${encodeURIComponent(name)}?before=${res.data.next}">Older runs</a></nav>` : ""}`;
  return page(core.shell, ctx, { title: `Runs of ${name}`, active: "workflows", body, ...g.d });
}

const ACTIVE = new Set(["queued", "running", "sleeping", "waiting"]);

export async function runPage(core: Core, ctx: Context, id: string): Promise<Response> {
  const g = await guard(core, ctx, "workflows:read");
  if (g instanceof Response) return g;
  const res = await sub(core.app, ctx, "GET", `${core.wfPrefix}/runs/${encodeURIComponent(id)}`);
  if (!res.ok) return errorPage(core, ctx, g.d, res.status, "Run not found", res.data?.error?.message ?? "", "workflows");
  const run = res.data;
  const p = core.path;
  const manage = can(ctx, "workflows:manage");
  const done = ctx.url.searchParams.get("done");
  const steps: any[] = Array.isArray(run.steps) ? run.steps : [];
  const body = html`<div class="page-head"><h1>Run ${String(run.id).slice(0, 8)} of ${run.workflow}</h1><div class="toolbar"><a class="btn" href="${p}/workflows/runs/${encodeURIComponent(run.workflow)}">All runs</a>${
    manage && ACTIVE.has(run.status) ? html`<form method="post" action="${p}/workflows/run/${encodeURIComponent(run.id)}/cancel"><button type="submit" class="danger" data-confirm="Cancel this run?">Cancel run</button></form>` : ""
  }${manage && run.status === "failed" ? html`<form method="post" action="${p}/workflows/run/${encodeURIComponent(run.id)}/retry"><button type="submit" class="primary">Retry from the failed step</button></form>` : ""}</div></div>
${done === "cancel" ? alert("Run cancelled.", "ok") : done === "retry" ? alert("Retry started.", "ok") : ""}
<section class="panel"><dl class="meta"><dt>Status</dt><dd>${status(String(run.status))}</dd><dt>Trigger</dt><dd>${run.trigger?.type ?? ""}${run.trigger?.event ? ` · ${run.trigger.event}` : ""}</dd><dt>Started</dt><dd>${fmtTime(run.createdAt)}</dd><dt>Finished</dt><dd>${fmtTime(run.finishedAt)}</dd><dt>Duration</dt><dd>${fmtDuration(
    run.finishedAt ? run.finishedAt - run.createdAt : null,
  )}</dd>${run.error ? html`<dt>Error</dt><dd class="field-error">${run.error.step ? `${run.error.step}: ` : ""}${run.error.message}</dd>` : ""}</dl></section>
<h2>Steps</h2><div class="table-wrap"><table><caption class="sr-only">Step timeline</caption><thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Details</th></tr></thead><tbody>${
    steps.length
      ? steps.map(
          (s, i) =>
            html`<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.kind}</td><td>${status(String(s.status))}</td><td>${s.attempts ?? ""}</td><td>${fmtTime(s.startedAt)}</td><td>${fmtDuration(
              s.status === "completed" || s.status === "failed" ? s.updatedAt - s.startedAt : null,
            )}</td><td>${s.error ? html`<span class="field-error">${s.error.message}</span>` : s.waitingFor ? html`Waiting for ${s.waitingFor.event ?? "approval"}${s.waitingFor.expiresAt ? ` until ${fmtTime(s.waitingFor.expiresAt)}` : ""}` : ""}</td></tr>`,
        )
      : html`<tr><td colspan="8" class="muted">No steps ran yet.</td></tr>`
  }</tbody></table></div>`;
  return page(core.shell, ctx, { title: `Run ${String(run.id).slice(0, 8)}`, active: "workflows", body, ...g.d });
}

export async function runControl(core: Core, ctx: Context, id: string, op: "cancel" | "retry"): Promise<Response> {
  const d = await pageData(core, ctx);
  const res = await sub(core.app, ctx, "POST", `${core.wfPrefix}/runs/${encodeURIComponent(id)}/${op}`);
  if (!res.ok) return errorPage(core, ctx, d, res.status, op === "cancel" ? "Could not cancel" : "Could not retry", [res.data?.error?.message, res.data?.error?.fix].filter(Boolean).join(" "), "workflows");
  return redirect(`${core.path}/workflows/run/${encodeURIComponent(id)}?done=${op}`);
}
