// Stand-ins for the Workers runtime's built-in modules, so the CLI can import an app written for
// Workers on Bun (to read its plugins, routes and Cloudflare needs). workerd only runs Workflow
// classes that extend WorkflowEntrypoint from "cloudflare:workers", and Bun cannot import that
// module. Nothing here runs on Workers: wrangler bundles the real modules.

let installed = false;

class Entrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** Register `cloudflare:workers` (and friends) as virtual modules for later imports. Bun only; idempotent. */
export function installWorkersShims(): void {
  const bun = (globalThis as { Bun?: { plugin?(p: { name: string; setup(build: any): void }): void } }).Bun;
  if (installed || typeof bun?.plugin !== "function") return;
  installed = true;
  bun.plugin({
    name: "miu-workers-shims",
    setup(build) {
      build.module("cloudflare:workers", () => ({
        loader: "object",
        exports: {
          DurableObject: class DurableObject extends Entrypoint {},
          WorkerEntrypoint: class WorkerEntrypoint extends Entrypoint {},
          WorkflowEntrypoint: class WorkflowEntrypoint extends Entrypoint {},
          RpcTarget: class RpcTarget {},
          env: {},
          waitUntil: () => {},
        },
      }));
      build.module("cloudflare:sockets", () => ({
        loader: "object",
        exports: {
          connect: () => {
            throw new Error("cloudflare:sockets is only available on Cloudflare Workers");
          },
        },
      }));
    },
  });
}
