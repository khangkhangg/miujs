import { errors, type MiuError } from "miujs";

/** Every error this package raises. Codes are stable; messages never contain keys or secrets. */
export function migrateError(code: string, status: number, message: string, fix: string, details?: unknown): MiuError {
  return errors.custom({ code: `MIU_E_MIGRATE_${code}`, status, message, fix, details });
}
