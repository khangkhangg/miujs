import { HttpError, MAX_LIMIT, t } from "miujs";
import { admin } from "miujs/admin";
import { sqliteRepository } from "miujs/sqlite";
import { SLUG_PATTERN, validateTourGraph, type Tour } from "miujs/tour";
import { createUser, findUser, randomToken, type Data } from "./data.ts";

/**
 * Back-office at /admin for users with the "admin" role: browse and fix tours, scenes and users.
 * Tours and scenes are created in the editor (/editor), which uploads panoramas and keeps hotspots consistent;
 * deleting there also removes a tour's scenes, hotspots and images, so the admin does not create or delete them.
 */
export function backOffice(data: Data) {
  const audit = sqliteRepository<any>({ db: data.db, table: "audit_log", indexes: ["resource"] });
  const editorOnly = { create: [], delete: [] };
  return admin({
    title: "Tours admin",
    loginUrl: "/login",
    audit,
    resources: {
      tours: {
        label: "Tours",
        repo: data.tours,
        schema: t.object({
          title: t.string({ min: 1, max: 120 }),
          slug: t.string({ pattern: SLUG_PATTERN }),
          status: t.enum(["draft", "published"]),
          description: t.optional(t.string({ max: 2000 })),
          ownerId: t.string(),
          startSceneId: t.optional(t.string()),
        }),
        titleField: "title",
        listFields: ["title", "slug", "status", "ownerId", "updatedAt"],
        defaultSort: "-updatedAt",
        permissions: editorOnly,
        // Publishing from the admin runs the same checks as the editor's "Publish" button.
        hooks: {
          beforeUpdate: async (patch, ctx) => {
            const before = ctx.before as Tour | undefined;
            if (patch.status !== "published" || !before || before.status === "published") return;
            const tourId = before.id;
            const scenes = (await data.scenes.list({ where: { tourId }, limit: MAX_LIMIT })).items;
            const hotspots = (await data.hotspots.list({ where: { tourId }, limit: MAX_LIMIT })).items;
            const problems = validateTourGraph({ startSceneId: (patch.startSceneId ?? before.startSceneId) as string | undefined }, scenes, hotspots);
            if (problems.length) throw new HttpError(422, `Cannot publish: ${problems.map((p) => p.message).join(" ")}`, { code: "tour_invalid" });
          },
        },
        fields: {
          ownerId: { label: "Owner", widget: "relation", relation: { resource: "users", labelField: "email" } },
          startSceneId: { label: "Start scene", widget: "relation", relation: { resource: "scenes", labelField: "title" } },
          description: { widget: "textarea" },
        },
      },
      scenes: {
        label: "Scenes",
        repo: data.scenes,
        schema: t.object({
          title: t.string({ min: 1, max: 120 }),
          tourId: t.string(),
          order: t.integer({ min: 0 }),
          panoramaKey: t.string(),
          width: t.integer(),
          height: t.integer(),
        }),
        titleField: "title",
        listFields: ["title", "tourId", "order", "width", "height"],
        defaultSort: "order",
        permissions: editorOnly,
        fields: {
          tourId: { label: "Tour", widget: "relation", relation: { resource: "tours", labelField: "title" }, readOnly: true },
          panoramaKey: { readOnly: true },
          width: { readOnly: true },
          height: { readOnly: true },
        },
      },
      users: {
        label: "Users",
        repo: data.users,
        schema: t.object({
          email: t.string({ format: "email" }),
          name: t.string({ min: 1, max: 80 }),
          roles: t.array(t.enum(["creator", "admin"])),
          passwordHash: t.optional(t.string()),
        }),
        titleField: "email",
        listFields: ["email", "name", "roles", "createdAt"],
        defaultSort: "-createdAt",
        // People sign up themselves (that sets their password); admins edit names and roles.
        permissions: { create: [] },
        fields: { passwordHash: { hidden: true }, roles: { help: '["creator"] or ["creator", "admin"]' } },
      },
    },
  });
}

/** Create the admin account once. Without a password, one is generated and printed. */
export async function seedAdmin(data: Data, email: string, password?: string): Promise<void> {
  if (await findUser(data, email)) return;
  const pw = password ?? randomToken(12);
  await createUser(data, { email, name: "Admin", password: pw, roles: ["creator", "admin"] });
  console.log(`Created admin user ${email}${password ? "" : ` with password: ${pw}  (set ADMIN_PASSWORD to choose one)`}`);
}
