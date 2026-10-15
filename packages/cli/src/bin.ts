#!/usr/bin/env bun
import { runCli } from "./index.ts";

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exit(code);
