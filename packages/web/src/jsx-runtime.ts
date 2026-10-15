/**
 * JSX that renders straight to escaped HTML strings, no virtual DOM and no build step.
 * Put `/** @jsxImportSource @miujs/web *\/` at the top of a .tsx file (or set
 * `"jsx": "react-jsx", "jsxImportSource": "@miujs/web"` in tsconfig.json).
 */
import { webErrors } from "./errors.ts";
import { HtmlString, appendValue, escapeHtml } from "./html.ts";

type Props = Record<string, unknown> & { children?: unknown };
type Component = (props: any) => unknown;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// Lowercase HTML tags, SVG camelCase tags (linearGradient) and custom elements (model-viewer).
const TAG = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9._-]*)?$/;
// Stricter than the HTML spec on purpose: no quotes, spaces, `=`, `/`, `>` or control characters.
const ATTR = /^[A-Za-z_:@][A-Za-z0-9_:.@-]*$/;
const RENAME: Record<string, string> = { className: "class", htmlFor: "for" };

/** `<>…</>`. */
export function Fragment(props: { children?: unknown }): HtmlString {
  return new HtmlString(appendValue("", props.children));
}

function cssProp(name: string): string {
  if (name.startsWith("--")) return name;
  return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

function styleText(style: unknown): string {
  if (typeof style !== "object" || style === null) return String(style);
  let out = "";
  for (const [k, v] of Object.entries(style)) {
    if (v === null || v === undefined || v === false || v === "") continue;
    if (!ATTR.test(k) && !/^--[A-Za-z0-9_-]+$/.test(k)) throw webErrors.jsxAttr(k);
    out += (out ? ";" : "") + cssProp(k) + ":" + String(v);
  }
  return out;
}

function attrs(props: Props): string {
  let out = "";
  for (const key in props) {
    if (key === "children" || key === "dangerouslySetInnerHTML" || key === "key" || key === "ref") continue;
    const v = props[key];
    if (key.length > 2 && (key[0] === "o" || key[0] === "O") && (key[1] === "n" || key[1] === "N")) throw webErrors.jsxEventHandler(key);
    if (!ATTR.test(key)) throw webErrors.jsxAttr(key);
    if (v === null || v === undefined) continue;
    const name = RENAME[key] ?? key;
    if (typeof v === "boolean") {
      if (name.startsWith("aria-") || name.startsWith("data-")) out += ` ${name}="${v}"`;
      else if (v) out += ` ${name}`;
      continue;
    }
    if (typeof v === "function") throw webErrors.htmlFunction();
    if (name === "style") {
      const css = styleText(v);
      if (css) out += ` style="${escapeHtml(css)}"`;
      continue;
    }
    out += ` ${name}="${escapeHtml(String(v))}"`;
  }
  return out;
}

function innerHtml(props: Props): string | null {
  const d = props.dangerouslySetInnerHTML as { __html?: unknown } | undefined;
  if (d === undefined || d === null) return null;
  if (typeof d !== "object" || typeof d.__html !== "string" || (props.children !== undefined && props.children !== null)) throw webErrors.jsxInnerHtml();
  return d.__html;
}

/** Automatic-runtime entry. Called by the transpiler; you rarely call it yourself. */
export function jsx(type: string | Component, props: Props | null, _key?: unknown): HtmlString {
  const p = props ?? {};
  if (typeof type === "function") {
    const out = type(p);
    return new HtmlString(appendValue("", out));
  }
  if (typeof type !== "string" || !TAG.test(type)) throw webErrors.jsxTag(String(type));
  const open = `<${type}${attrs(p)}>`;
  if (VOID.has(type.toLowerCase())) {
    if ((p.children !== undefined && p.children !== null) || p.dangerouslySetInnerHTML !== undefined) throw webErrors.jsxVoidChildren(type);
    return new HtmlString(open);
  }
  const inner = innerHtml(p);
  return new HtmlString(open + (inner ?? appendValue("", p.children)) + `</${type}>`);
}

/** Same as `jsx`; the transpiler uses it for elements with static children arrays. */
export const jsxs = jsx;

export type { HtmlString };

/** Types the TypeScript compiler looks up for `jsxImportSource: "@miujs/web"`. Type-only, erased. */
export declare namespace JSX {
  type Element = HtmlString;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [tag: string]: {
      children?: unknown;
      style?: string | Record<string, string | number | null | undefined | false>;
      dangerouslySetInnerHTML?: { __html: string };
      [attr: string]: unknown;
    };
  }
}
