/** @jsxImportSource @miujs/web */
// The page shell. Every full page load gets it; htmx requests get just the fragment.

import { raw } from "@miujs/web";

export function Layout(props: { title: string; children?: unknown }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{props.title}</title>
          <script src="https://unpkg.com/htmx.org@2.0.4" crossorigin="anonymous"></script>
          <style>{"body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.4rem 1rem}"}</style>
        </head>
        <body hx-boost="true">{props.children}</body>
      </html>
    </>
  );
}
