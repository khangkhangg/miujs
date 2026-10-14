#!/usr/bin/env bun
// MiuJS CLI. Also runs on Node 22+: node --experimental-strip-types bin/miu.ts --help
import process from "node:process";
import { main } from "../src/cli/main.ts";

const code = await main(process.argv.slice(2));
// Exit explicitly: an imported app module may hold the event loop open (timers, queues).
process.exit(code);
