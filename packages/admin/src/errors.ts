import { errors, type Issue, type MiuError } from "miujs";

const config = (code: string, message: string, fix: string, details?: unknown) => errors.config(`MIU_E_ADMIN_${code}`, message, fix, details);
const client = (code: string, status: number, message: string, fix: string, details?: unknown) =>
  errors.custom({ code: `MIU_E_ADMIN_${code}`, status, message, fix, details });

/** Every error @miujs/admin throws: a stable `MIU_E_ADMIN_*` code, a message and a fix. */
export const adminErrors = {
  // Definition mistakes (thrown at startup).
  resourceInvalid: (message: string, fix: string) => config("RESOURCE_INVALID", message, fix),
  resourceDuplicate: (name: string) =>
    config("RESOURCE_DUPLICATE", `Two resources are named "${name}"`, "Give each resource a unique name, or pass each resource to admin({ resources }) once."),
  fieldInvalid: (resource: string, fieldName: string, message: string, fix: string) => config("FIELD_INVALID", `${resource}.${fieldName}: ${message}`, fix),
  fieldReserved: (resource: string, fieldName: string) =>
    config(
      "FIELD_RESERVED",
      `${resource}.${fieldName}: "${fieldName}" is reserved`,
      "Rename the field. Reserved: id, orgId, createdAt, updatedAt, createdBy, updatedBy, deletedAt and the list query keys filter, sort, cursor, limit, q, fields, view, include.",
    ),
  viewInvalid: (resource: string, view: string, message: string, fix: string) => config("VIEW_INVALID", `${resource} view "${view}": ${message}`, fix),
  actionInvalid: (resource: string, action: string, message: string, fix: string) => config("ACTION_INVALID", `${resource} action "${action}": ${message}`, fix),
  searchInvalid: (resource: string) =>
    config("SEARCH_INVALID", `${resource} has search: true but no searchable text field`, "Mark at least one text/email/phone/url/longText/richText field with { searchable: true }, or remove search: true."),
  relationUnknown: (resource: string, fieldName: string, target: string, known: string[]) =>
    config(
      "RELATION_UNKNOWN",
      `${resource}.${fieldName} points to "${target}", which is not one of the admin resources`,
      `Pass the "${target}" resource to admin({ resources }) too. Known: ${known.join(", ") || "(none)"}.`,
    ),
  databaseMissing: () =>
    config(
      "DATABASE_MISSING",
      "admin() has no database",
      "Pass admin({ database }) (e.g. sqlite(\"app.db\") or d1(\"DB\")), or add db() from @miujs/db before admin() in plugins.",
    ),
  serviceMissing: () =>
    config("NOT_READY", "The admin data API was used before the app started", "Call `await app.ready()` first, and use the admin() plugin instance that is in miu({ plugins })."),

  // Request errors.
  notFound: (resource: string, id: string) =>
    client("RECORD_NOT_FOUND", 404, `${resource} ${JSON.stringify(id)} not found`, `Check the id. List records with GET /${resource}; records of other organizations and deleted records are not visible.`),
  filterInvalid: (message: string, details?: unknown) =>
    client(
      "FILTER_INVALID",
      400,
      `Invalid filter: ${message}`,
      'Send filter as JSON {"field": {"op": value}} with op one of eq, ne, gt, gte, lt, lte, in, contains, isNull, or as query keys like ?stage=lead&value[gte]=1000. See GET /_admin/schema for fields and operators.',
      details,
    ),
  sortInvalid: (value: string, allowed: string[]) =>
    client("SORT_INVALID", 400, `Cannot sort by ${JSON.stringify(value)}`, `Sort by one field, prefixed with - for descending. Sortable: ${allowed.join(", ")}.`),
  cursorInvalid: () => client("CURSOR_INVALID", 400, "Invalid cursor", "Pass the nextCursor from the previous page unchanged, with the same sort and filters."),
  fieldsInvalid: (names: string[], allowed: string[]) =>
    client("FIELDS_INVALID", 400, `Unknown field(s) in fields: ${names.join(", ")}`, `Use a comma-separated list of: ${allowed.join(", ")}.`),
  includeInvalid: (names: string[], allowed: string[]) =>
    client("INCLUDE_INVALID", 400, `Cannot include: ${names.join(", ")}`, allowed.length ? `Include relation fields only: ${allowed.join(", ")}.` : "This resource has no relation fields to include."),
  viewUnknown: (resource: string, view: string, allowed: string[]) =>
    client("VIEW_UNKNOWN", 400, `${resource} has no view "${view}"`, allowed.length ? `Use one of: ${allowed.join(", ")}.` : "This resource has no saved views."),
  actionUnknown: (resource: string, action: string, allowed: string[]) =>
    client("ACTION_UNKNOWN", 404, `${resource} has no action "${action}"`, allowed.length ? `Use one of: ${allowed.join(", ")}.` : "This resource defines no actions."),
  unique: (resource: string, fieldName: string) =>
    client("UNIQUE", 409, `Another ${resource} record already has this ${fieldName}`, `Use a different ${fieldName}, or update the existing record instead.`, { field: fieldName }),
  relationInvalid: (resource: string, fieldName: string, target: string, id: unknown) =>
    client(
      "RELATION_INVALID",
      400,
      `${resource}.${fieldName}: ${target} ${JSON.stringify(id)} does not exist`,
      `Use the id of an existing ${target} record in the same organization (GET /${target}).`,
      { field: fieldName },
    ),
  importInvalid: (rowErrors: unknown[]) =>
    client("IMPORT_INVALID", 400, `Import refused: ${rowErrors.length} row(s) have errors; nothing was written`, "Fix the rows listed in details.rows (row 1 is the first data row after the header), then import again. Use dryRun: true to check first.", {
      rows: rowErrors,
    }),
  importEmpty: () => client("IMPORT_EMPTY", 400, "The CSV has no data rows", "Send a CSV with a header row and at least one data row, as `csv` (JSON) or a `file` upload."),
  importTooLarge: (max: number) => client("IMPORT_TOO_LARGE", 413, `The CSV has more than ${max} rows`, `Split the file into chunks of at most ${max} rows.`),
  inUse: (resource: string) =>
    client("IN_USE", 409, `This ${resource} record is still referenced by other records`, "Delete or re-link the records that point to it first, or define the relation with onDelete: \"set null\" or \"cascade\"."),
  noTenant: (resource: string) =>
    client("NO_TENANT", 400, `${resource} is organization-scoped but no organization is active`, "Send the organization id (x-org-id header with @miujs/access's default orgFrom), or pass orgId to the admin data API."),
  resourceUnknown: (name: string, known: string[]) =>
    client("RESOURCE_UNKNOWN", 404, `No admin resource named "${name}"`, `Use one of: ${known.join(", ") || "(none)"}.`),
  hookRejected: (message: string) => client("HOOK_REJECTED", 400, message, "A resource hook refused this change. Read the message for what to change."),
  validation: (issues: Issue[]): MiuError => errors.validation("body", issues),

  // System area (plugins' manage() sections).
  systemPluginUnknown: (name: string, known: string[]) =>
    client("SYSTEM_PLUGIN_UNKNOWN", 404, `No plugin named "${name}" in the System area`, `Use one of: ${known.join(", ") || "(none)"}. GET <basePath>/_admin/system lists the plugins you may read.`),
  systemSectionUnknown: (plugin: string, section: string, known: string[]) =>
    client("SYSTEM_SECTION_UNKNOWN", 404, `Plugin "${plugin}" has no section "${section}"`, known.length ? `Use one of: ${known.join(", ")}.` : `"${plugin}" has no manage() sections; GET <basePath>/_admin/system/${plugin} shows what it offers.`),
  systemListUnknown: (plugin: string, section: string, list: string, known: string[]) =>
    client("SYSTEM_LIST_UNKNOWN", 404, `Section ${plugin}/${section} has no list "${list}"`, known.length ? `Use one of: ${known.join(", ")}.` : "This section has no lists."),
  systemActionUnknown: (plugin: string, section: string, action: string, known: string[]) =>
    client("SYSTEM_ACTION_UNKNOWN", 404, `Section ${plugin}/${section} has no action "${action}" here`, known.length ? `Use one of: ${known.join(", ")}.` : "There are no actions here."),
  systemSettingsUnknown: (plugin: string, section: string) =>
    client("SYSTEM_SETTINGS_UNKNOWN", 404, `Section ${plugin}/${section} has no settings`, "Only sections whose manage() entry has `settings` can be read or changed here."),
  systemForbidden: (permission: string, withAccess: boolean) =>
    client(
      "SYSTEM_FORBIDDEN",
      403,
      withAccess ? `Missing permission "${permission}"` : "The System area needs the admin role",
      withAccess
        ? `Give the user a global role (user.roles, not an organization role) that grants "${permission}", e.g. operator: ["system:*"] in defineRoles(). "system:<verb>" grants it for every plugin, "system.<plugin>:*" everything on one plugin.`
        : 'Sign in as a user whose roles include "admin", or install @miujs/access and grant "system:*" / "system.<plugin>:<verb>" permissions.',
    ),
  systemOrgScoped: () =>
    client(
      "SYSTEM_ORG_SCOPED",
      400,
      "System routes are app-wide and do not take an organization",
      "Send the request without x-org-id (or the org your access() orgFrom reads): System permissions come from the user's global roles, never from an organization role.",
    ),
  systemFilterInvalid: (message: string) =>
    client("SYSTEM_FILTER_INVALID", 400, `Invalid filters: ${message}`, 'Send filters as a JSON object of the list\'s filter keys to one of their options, e.g. filters={"state":"failed"}. GET the section to see each list\'s filters.'),
  systemSearchUnsupported: (list: string) =>
    client("SYSTEM_SEARCH_UNSUPPORTED", 400, `List "${list}" is not searchable`, "Leave out `search`, or use the list's filters instead."),
};
