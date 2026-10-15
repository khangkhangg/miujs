// The admin UI's two static files, built once per plugin instance: the stylesheet and one
// script assembled from the self-contained client modules (`(${fn})()`), no bundler needed.
// Names carry a content hash so they can be cached forever.

import { adminApp } from "./client/app.ts";
import { exprLib } from "./client/expr.ts";
import { filterLib } from "./client/filters.ts";
import { importerLib } from "./client/importer.ts";
import { kanbanLib } from "./client/kanban.ts";
import { schemaFormLib } from "./client/schema-form.ts";
import { workflowLib } from "./client/workflow.ts";
import { adminCss } from "./styles.ts";

export interface Asset {
  name: string;
  type: string;
  body: string;
}

/** FNV-1a, two lanes → 16 hex chars. Not for security; only cache busting. */
export function contentHash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const LIBS = { filters: filterLib, kanban: kanbanLib, expr: exprLib, workflow: workflowLib, schemaForm: schemaFormLib, importer: importerLib };

export function clientScript(): string {
  const libs = Object.entries(LIBS)
    .map(([k, fn]) => `${k}: (${fn.toString()})()`)
    .join(",\n");
  // `__name` covers bundlers that run with keepNames (they insert __name(fn, "x") calls).
  return `/* @miujs/admin UI */\n(function () {\n"use strict";\nvar __name = function (f) { return f; };\nvar L = {\n${libs}\n};\n(${adminApp.toString()})(L);\n})();\n`;
}

export function buildAssets(accent?: string): { css: Asset; js: Asset } {
  const css = adminCss(accent);
  const js = clientScript();
  return {
    css: { name: `admin.${contentHash(css)}.css`, type: "text/css; charset=utf-8", body: css },
    js: { name: `admin.${contentHash(js)}.js`, type: "text/javascript; charset=utf-8", body: js },
  };
}
