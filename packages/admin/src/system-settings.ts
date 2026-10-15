// Runtime settings from plugins' manage() sections: saved in `admin_system_settings` and applied
// again by every instance. Each instance re-reads the table at most once per TTL (default 30 s),
// on a request, so a change made on one Workers isolate reaches the others within the TTL.

import { validate, type Context, type ManageSettings } from "miujs";
import { tableSql, type Database, type Migration, type TableDescription } from "@miujs/db";

export const SETTINGS_TABLE = "admin_system_settings";

/** The settings table as a plain description (`introspect()` shape), for adminTables() and Drizzle diffs. */
export function settingsTable(): TableDescription {
  const col = (name: string, type: string, notNull: boolean, primaryKey = false) => ({ name, type, notNull, default: null, primaryKey });
  return {
    name: SETTINGS_TABLE,
    columns: [col("plugin", "TEXT", true, true), col("section", "TEXT", true, true), col("value", "TEXT", true), col("updated_at", "INTEGER", true), col("updated_by", "TEXT", false)],
    primaryKey: ["plugin", "section"],
    indexes: [],
    foreignKeys: [],
  };
}

export const systemMigration: Migration = {
  id: "admin_system_001_settings",
  sql: tableSql(settingsTable()).map((s) => `${s};`).join("\n"),
};

export interface SettingsTarget {
  plugin: string;
  section: string;
  settings: ManageSettings;
}

export const settingsKey = (plugin: string, section: string) => `${plugin}\u0000${section}`;

export interface SettingsSyncOptions {
  ttlMs: number;
  now(): number;
  /** Sections with settings, by settingsKey(). */
  targets(): Map<string, SettingsTarget>;
  log(message: string, data?: Record<string, unknown>): void;
}

export class SettingsSync {
  private checkedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  /** The stored JSON text last applied (or skipped as invalid) per section. */
  private applied = new Map<string, string>();
  private o: SettingsSyncOptions;

  constructor(o: SettingsSyncOptions) {
    this.o = o;
  }

  /** Applies stored values that changed since the last read, when the TTL has passed. Never throws. */
  sync(db: () => Promise<Database>, ctx: Context): Promise<void> | undefined {
    if (this.inflight) return this.inflight;
    if (this.o.now() - this.checkedAt < this.o.ttlMs) return undefined;
    this.checkedAt = this.o.now();
    this.inflight = this.load(db, ctx).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(db: () => Promise<Database>, ctx: Context): Promise<void> {
    const targets = this.o.targets();
    if (!targets.size) return;
    let rows: { plugin: string; section: string; value: string }[];
    try {
      rows = ((await (await db()).prepare(`SELECT "plugin", "section", "value" FROM "${SETTINGS_TABLE}"`).all()) as { results: typeof rows }).results ?? [];
    } catch (err) {
      this.o.log("admin: reading System settings failed (run adminMigrations()?)", { err });
      return;
    }
    for (const row of rows) {
      const key = settingsKey(row.plugin, row.section);
      const target = targets.get(key);
      if (!target || this.applied.get(key) === row.value) continue;
      this.applied.set(key, row.value);
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        this.o.log("admin: stored System settings are not JSON; skipped", { plugin: row.plugin, section: row.section });
        continue;
      }
      const checked = validate(target.settings.schema, parsed);
      if (!checked.ok) {
        this.o.log("admin: stored System settings no longer match the schema; skipped", { plugin: row.plugin, section: row.section, issues: checked.issues });
        continue;
      }
      try {
        await target.settings.set(checked.value, ctx);
      } catch (err) {
        this.o.log("admin: applying stored System settings failed", { plugin: row.plugin, section: row.section, err });
      }
    }
  }

  /** Saves a value already applied to the plugin on this instance. */
  async save(db: Database, plugin: string, section: string, value: unknown, actor: string | null): Promise<void> {
    const text = JSON.stringify(value);
    await db
      .prepare(
        `INSERT INTO "${SETTINGS_TABLE}" ("plugin", "section", "value", "updated_at", "updated_by") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("plugin", "section") DO UPDATE SET "value" = excluded."value", "updated_at" = excluded."updated_at", "updated_by" = excluded."updated_by"`,
      )
      .bind(plugin, section, text, this.o.now(), actor)
      .run();
    this.applied.set(settingsKey(plugin, section), text);
  }
}
