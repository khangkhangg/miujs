// Shared facts about the repo layout for the docs and release scripts.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const GITHUB_REPO = "khangkhangg/miujs";
export const GITHUB_BRANCH = "miujs-monorepo";
/** Rendered page on GitHub, e.g. blobUrl("docs/errors.md"). */
export const blobUrl = (path: string) => `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${path}`;
/** Raw markdown, for llms.txt readers. */
export const rawUrl = (path: string) => `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`;

/**
 * Packages with a README, a tested snippet and an llms.txt entry, in reading order.
 * admin, game, tour and migrate are still being built and are left out until their APIs settle.
 */
export const DOCUMENTED_PACKAGES = [
  "miujs",
  "cli",
  "auth",
  "session",
  "db",
  "cache",
  "queue",
  "ratelimit",
  "bots",
  "realtime",
  "files",
  "web",
  "mail",
  "access",
  "audit",
  "workflows",
  "ai",
] as const;

export type PackageJson = {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type?: string;
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  devDependencies?: Record<string, string>;
};

export function readPackageJson(pkg: string): PackageJson {
  return JSON.parse(readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8"));
}

/** Forward slashes on every OS, for output that ends up in docs. */
export const slash = (p: string) => p.replaceAll("\\", "/");
