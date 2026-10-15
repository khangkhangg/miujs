# Releasing MiuJS to npm

All packages (`miujs` and every `@miujs/*`) share one version and are published together by
[.github/workflows/release.yml](.github/workflows/release.yml) when a `v*` tag is pushed.

Released packages: `miujs`, `@miujs/cli`, `auth`, `session`, `db`, `cache`, `queue`, `ratelimit`,
`bots`, `realtime`, `files`, `web`, `mail`, `access`, `audit`, `workflows` and `ai`
(`RELEASE_PACKAGES` in [scripts/build-packages.ts](scripts/build-packages.ts)). `admin`, `game`,
`tour` and `migrate` stay unpublished until their APIs settle.

## One-time setup (maintainer)

1. **The unscoped `miujs` name.** It is taken on npm by an unrelated project
   (`miujs@0.1.64`, "Simple and fast build tool for website", maintainer `mast1ff`, repository
   `tknf/miujs`). `scripts/release/publish.ts` refuses to publish over it. Pick one:
   - ask the owner to transfer it (`npm owner add <you> miujs`), or file a name dispute with npm
     support ([docs.npmjs.com/policies/disputes](https://docs.npmjs.com/policies/disputes));
   - or rename the core package to `@miujs/core`. That is a code change across the repo (every
     `from "miujs"` import, `declare module "miujs"` augmentations, docs and templates), so decide
     it before the first release: renaming after users install is a breaking change.
2. **The `@miujs` scope.** Sign in at npmjs.com, then *Add Organization* → name `miujs` (the free
   plan is enough for public packages). Every `@miujs/*` package publishes with `--access public`.
   Turn on 2FA for the account and the organization.
3. **A publish token.** npmjs.com → *Access Tokens* → *Generate New Token* → *Granular Access
   Token*: packages and scopes `@miujs` (and `miujs` once you own it), permission *Read and
   write*, an expiry you will remember to renew. (A classic *Automation* token also works and skips
   2FA prompts in CI.)
4. **The GitHub secret.** Repository → *Settings* → *Secrets and variables* → *Actions* → *New
   repository secret* → name `NPM_TOKEN`, value the token.
5. **Provenance.** The workflow publishes with `--provenance` (it has `id-token: write`). npm
   only accepts provenance from a **public** GitHub repository whose URL matches each
   package's `repository.url` (`github.com/khangkhangg/miujs`, set in `scripts/lib/repo.ts`).
   While the repository is private, remove `--provenance` from the Publish step.
6. **The commercial license contact.** `COMMERCIAL-LICENSE.md` ships in every package next to the
   AGPL `LICENSE` and still says `TODO: add your sales contact`. Publishing refuses to run until
   that TODO is gone.

## Every release

```bash
bun scripts/release/version.ts minor        # or patch, major, or an exact 1.0.0-rc.1
#   bumps every packages/*/package.json in lockstep and prepends a CHANGELOG.md entry built from
#   the commit subjects since the last tag (or pass --notes "..."); edit the entry if you like
bun install                                  # refresh bun.lock
bun scripts/build-packages.ts                # dist/npm/<pkg>: JS, .d.ts, src, manifest
bun scripts/release/verify.ts --no-build     # pack + install + run on Node, Deno, Bun, Workers, tsc
git commit -am "release: v0.2.0"
git tag v0.2.0
git push && git push origin v0.2.0           # the Release workflow takes it from here
```

The workflow runs `bun test`, the typecheck, the build and `verify.ts`, then
`scripts/release/publish.ts --provenance`, which publishes in dependency order (`miujs` first).
It stops before uploading anything if the tag does not match the version, versions are not in
lockstep, a `workspace:` range survived, `COMMERCIAL-LICENSE.md` has a TODO, `NPM_TOKEN` is missing,
or a name belongs to someone else. Versions already on npm are skipped, so a failed run can simply
be re-run. Prereleases (`1.0.0-rc.1`) go to the `next` dist-tag, everything else to `latest`.

**Dry run:** Actions → *Release* → *Run workflow* (dry run is ticked by default) runs everything
with `npm publish --dry-run`. Locally: `bun scripts/release/publish.ts --dry-run` (no login needed;
it warns about the checks above instead of stopping).

## What gets published

`bun scripts/build-packages.ts` stages each package in `dist/npm/<pkg>/` with:

- `dist/*.js` (ESM, built by Bun) and `dist/types/*.d.ts` (tsc); `src/*.ts` for Bun.
- `exports` conditions: `types` → `.d.ts`, `bun` → `src/*.ts`, `default` → `dist/*.js` (Node, Deno,
  Wrangler/esbuild and other bundlers). No `deno` → src condition: Deno and Node refuse to strip
  types inside `node_modules`.
- `workspace:*` dependencies rewritten to `^<version>`; dev dependencies dropped.
- `license: AGPL-3.0-only`, `LICENSE` and `COMMERCIAL-LICENSE.md`, `repository`, `homepage`,
  `bugs`, `engines.node >=24`, `publishConfig.access: public` for scoped packages.
- `sideEffects: false`, except files a package lists (`miujs` `src/websocket.ts`, `@miujs/db`
  `src/drizzle.ts`, `@miujs/queue` `src/cloudflare.ts`, the CLI's `bin`). The build fails when a
  source module runs code on import without being listed, and when a `.d.ts` imports a `.ts` path
  or a package the manifest does not depend on.

`bun scripts/release/verify.ts` (about a minute; needs Node 24 with npm, Deno 2 and the npm
registry for typescript, esbuild, @types/node and the optional peers) packs every package with
`npm pack`, then in fresh projects under the system temp directory:

| step | what it proves |
|---|---|
| pack | each tarball has README, both license files and every `exports`/`main`/`bin` target, and no tests |
| node | `npm install` of the tarballs only (no registry copy of ours); every export imports from `dist/*.js`; an app with auth + session + db (node:sqlite) + cache + queue + realtime + bots answers real HTTP through `miujs/node` |
| types | `tsc --noEmit` with `strict`, `skipLibCheck: false`, `nodenext` and no lib `"dom"` (lib es2023 + @types/node), every export, after deleting the packages' `src/`; DOM-only names fail, except in packages listed in `DOM_LIB_PENDING` (`miujs` for now), which are listed as a warning |
| workers | esbuild with Wrangler's `workerd`/`worker`/`browser` conditions: no static `node:`/`bun:` imports, no `src/*.ts`, no `eval`; the bundle answers a request as `workerd` |
| deno | Deno 2 runs the same app with bare and `npm:` specifiers, and `deno check` passes |
| bun | `bun install` of the tarballs; Bun runs the app from the TypeScript source |

Flags: `--no-build`, `--only node,types`, `--skip deno`, `--keep` (keep the temp projects).
