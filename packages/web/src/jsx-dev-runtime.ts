import { jsx } from "./jsx-runtime.ts";
import type { HtmlString } from "./html.ts";

export { Fragment, jsx, jsxs, type JSX } from "./jsx-runtime.ts";

/** Development-mode entry (`jsx: "react-jsxdev"`, Bun's default outside production). */
export function jsxDEV(type: any, props: any, key?: unknown, _isStatic?: boolean, _source?: unknown, _self?: unknown): HtmlString {
  return jsx(type, props, key);
}
