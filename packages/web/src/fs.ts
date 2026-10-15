/**
 * File access for staticFiles on Bun, Node and Deno. `node:*` modules load lazily through a
 * variable specifier so Workers bundles never include them (AGENTS.md rule 3).
 */
import { detectRuntime } from "miujs";

/** What `new Response(body)` accepts (the DOM's `BodyInit`), named without lib "dom". */
export type ResponseBody = NonNullable<ConstructorParameters<typeof Response>[0]>;

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileSource {
  name: string;
  /** `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;
  /** Body for bytes `start..end` inclusive. */
  body(path: string, start: number, end: number): ResponseBody | Promise<ResponseBody>;
  /** Resolve `dir` to an absolute path and give the platform separator. */
  root(dir: string): Promise<{ root: string; sep: string }>;
}

type NodeFs = typeof import("node:fs");
type NodeFsPromises = typeof import("node:fs/promises");
type NodePath = typeof import("node:path");
type NodeStream = typeof import("node:stream");

let mods: Promise<{ fs: NodeFs; fsp: NodeFsPromises; path: NodePath; stream: NodeStream }> | null = null;
function nodeModules() {
  const names = ["node:fs", "node:fs/promises", "node:path", "node:stream"];
  return (mods ??= Promise.all(names.map((n) => import(/* @vite-ignore */ n))).then(([fs, fsp, path, stream]) => ({ fs, fsp, path, stream })));
}

async function statWith(fsp: NodeFsPromises, path: string): Promise<FileStat | null> {
  try {
    const s = await fsp.stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
  } catch {
    return null;
  }
}

async function rootWith(dir: string) {
  const { path } = await nodeModules();
  return { root: path.resolve(dir), sep: path.sep };
}

/** Streams files with `node:fs` (Node, Deno; also works on Bun). */
export function nodeFileSource(): FileSource {
  return {
    name: "node:fs",
    root: rootWith,
    async stat(path) {
      return statWith((await nodeModules()).fsp, path);
    },
    async body(path, start, end) {
      const { fs, stream } = await nodeModules();
      if (end < start) return new Uint8Array(0);
      return stream.Readable.toWeb(fs.createReadStream(path, { start, end })) as unknown as ReadableStream;
    },
  };
}

declare const Bun: { file(path: string): Blob };

/** Uses `Bun.file`, which sends files with sendfile(2) when possible. */
export function bunFileSource(): FileSource {
  return {
    name: "bun",
    root: rootWith,
    async stat(path) {
      return statWith((await nodeModules()).fsp, path);
    },
    body(path, start, end) {
      return Bun.file(path).slice(start, end + 1);
    },
  };
}

export function defaultFileSource(): FileSource {
  return detectRuntime() === "bun" ? bunFileSource() : nodeFileSource();
}

/** Read a UTF-8 text file on Bun, Node or Deno. */
export async function readTextFile(path: string): Promise<string> {
  return (await nodeModules()).fsp.readFile(path, "utf8");
}
