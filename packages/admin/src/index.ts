// @miujs/admin — define a resource once; get its table, migrations, REST API, MCP tools,
// lifecycle events, permissions, audit trail, search and CSV import/export — plus the System
// area, which manages every plugin that implements manage().

export { adminErrors } from "./errors.ts";
export { field, FIELD_TYPES, currencyDigits, type Choice, type FieldDef, type FieldOptions, type FieldType, type ReferenceAction } from "./fields.ts";
export {
  createSchema,
  FILTER_OPS,
  humanize,
  isResource,
  resource,
  snakeCase,
  updateSchema,
  type ActionConfig,
  type ActionDef,
  type ActionInput,
  type AdminRecord,
  type DataAccess,
  type Filter,
  type FilterOp,
  type HookArgs,
  type Hooks,
  type Resource,
  type ResourceConfig,
  type ViewConfig,
  type ViewDef,
} from "./resource.ts";
export { isSafeHref, sanitizeHtml } from "./sanitize.ts";
export { adminMigrations, adminTables } from "./tables.ts";
export { csvCell, parseCsv } from "./csv.ts";
export { adminSchema, type ActionMeta, type AdminSchema, type Capability, type Endpoint, type FieldMeta, type ResourceMeta, type SchemaOptions } from "./meta.ts";
export { admin, type AdminOptions, type AdminPlugin, type AdminService, type DataScope } from "./plugin.ts";
export type { RowError, ImportResult } from "./transfer.ts";
export { actionPermission, permissionResource, systemAllowed } from "./system.ts";
