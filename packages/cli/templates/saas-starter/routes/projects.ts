// Projects belong to an organization. Every query filters by tenantScope(ctx): the org id the
// access plugin verified (x-org-id header or the session), never an id from the request body.

import { route, t, type CallFn } from "miujs";
import { tenantScope } from "@miujs/access";

const Project = t.object({ id: t.string(), name: t.string(), createdAt: t.string() });

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

export const listProjects = route.get("/projects", {
  summary: "List the active organization's projects",
  auth: "required",
  response: t.object({ projects: t.array(Project) }),
  handler: async (ctx) => {
    ctx.authorize("projects:read");
    const { results } = await ctx.db
      .prepare("SELECT id, name, created_at FROM projects WHERE org_id = ? ORDER BY created_at DESC")
      .bind(tenantScope(ctx))
      .all<ProjectRow>();
    return { projects: results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at })) };
  },
});

export const createProject = route.post("/projects", {
  summary: "Create a project in the active organization",
  auth: "required",
  body: t.object({ name: t.string({ minLength: 1, maxLength: 100 }) }),
  response: Project,
  handler: async (ctx) => {
    ctx.authorize("projects:write");
    const orgId = tenantScope(ctx);
    const project = { id: crypto.randomUUID(), name: ctx.body.name, createdAt: new Date().toISOString() };
    await ctx.db
      .prepare("INSERT INTO projects (id, org_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(project.id, orgId, project.name, ctx.user.id, project.createdAt)
      .run();
    await ctx.audit.log({ action: "create", resource: "projects", resourceId: project.id, after: project });
    await ctx.events.emit("project.created", { projectId: project.id, name: project.name, email: ctx.user.email ?? null });
    ctx.set.status = 201;
    return project;
  },
});

export const tests = {
  "listing projects needs a signed-in user": async (call: CallFn) => {
    (await call(listProjects)).expectStatus(401);
  },
  "creating a project needs a signed-in user": async (call: CallFn) => {
    (await call(createProject, { body: { name: "Apollo" } })).expectStatus(401);
  },
};
