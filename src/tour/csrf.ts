import type { Middleware } from "../core/app.ts";
import { csrf } from "../batteries/csrf.ts";

/** The tour kit's CSRF policy: `csrf({ requireNonSimple: true })` (JSON/upload APIs). */
export function csrfGuard(): Middleware {
  return csrf({ requireNonSimple: true });
}
