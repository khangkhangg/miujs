/**
 * Local-disk BlobStore for Bun and Node (`miujs/node`).
 *
 * Layout under `root`:
 *   meta/<key>.json  one JSON sidecar per blob: `{ v: 1, file, meta }` (mirrors the key's path, so it is browsable)
 *   data/<id>        the bytes, under a random, immutable id named by the sidecar
 *   tmp/             in-flight writes; anything left here after a crash is garbage
 *
 * Why per-blob sidecars rather than one index file: each write touches only its own small file,
 * so puts never contend on (or risk corrupting) a shared index, and other processes see a
 * consistent view without coordination. The sidecar rename is the commit point: data is
 * written + fsynced to tmp, renamed into data/, then the sidecar is atomically replaced. Readers
 * always see either the old or the new blob, never a torn one, and an open read keeps its file
 * even if the blob is overwritten meanwhile. Keeping data under ids (not the key path) also means
 * a key and a key below it (`a` and `a/b`) can coexist.
 */
import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertSafeKey, toBytes, type BlobBody, type BlobMeta, type BlobStore } from "../batteries/files/types.ts";

export interface DiskBlobStoreOptions {
  /** Directory holding the store (created when missing). */
  root: string;
  /** Clock for `uploadedAt`, in ms (tests). */
  now?: () => number;
  /**
   * How long a superseded or deleted data file is kept before removal, so reads that already started
   * (lazy Blob bodies) can finish. Default 60 s; 0 deletes immediately.
   */
  retainMs?: number;
}

interface Sidecar {
  v: 1;
  file: string;
  meta: BlobMeta;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

const isCode = (e: unknown, ...codes: string[]) => codes.includes((e as { code?: string })?.code ?? "");

function within(base: string, p: string): boolean {
  return p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
}

function escapeError(key: string): Error {
  return new Error(`Storage key ${JSON.stringify(key)} resolves outside the store root (symlink?)`);
}


/** Blobs on the local filesystem; see the module comment for the on-disk layout and guarantees. */
export function diskBlobStore(opts: DiskBlobStoreOptions): BlobStore {
  const now = opts.now ?? Date.now;
  let ready: Promise<{ meta: string; data: string; tmp: string }> | undefined;
  const dirs = () =>
    (ready ??= (async () => {
      await mkdir(opts.root, { recursive: true });
      const root = await realpath(resolve(opts.root));
      const d = { meta: join(root, "meta"), data: join(root, "data"), tmp: join(root, "tmp") };
      await Promise.all([mkdir(d.meta, { recursive: true }), mkdir(d.data, { recursive: true }), mkdir(d.tmp, { recursive: true })]);
      return d;
    })()).catch((e) => {
      ready = undefined;
      throw e;
    });

  // Serialise writes per key within this process so overwrite cleanup never orphans data files.
  const locks = new Map<string, Promise<unknown>>();
  function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => locks.get(key) === tail && locks.delete(key));
    return run;
  }

  /** Lexically resolve a key's sidecar path and refuse anything outside the meta tree. */
  async function metaPath(key: string): Promise<{ path: string; base: string }> {
    assertSafeKey(key);
    const d = await dirs();
    const path = resolve(d.meta, key + ".json");
    if (!within(d.meta, path)) throw escapeError(key);
    return { path, base: d.meta };
  }

  /** Read a sidecar after checking its real path (symlinks included) stays under the root. */
  async function readSidecar(key: string): Promise<{ path: string; sidecar: Sidecar } | undefined> {
    const { path, base } = await metaPath(key);
    let real: string;
    try {
      real = await realpath(path);
    } catch (e) {
      if (isCode(e, "ENOENT", "ENOTDIR")) return undefined;
      throw e;
    }
    if (!within(base, real)) throw escapeError(key);
    let sidecar: Sidecar;
    try {
      sidecar = JSON.parse(await readFile(real, "utf8")) as Sidecar;
    } catch (e) {
      if (isCode(e, "ENOENT")) return undefined;
      if (e instanceof SyntaxError) return undefined; // torn or foreign file: treat as absent
      throw e;
    }
    if (sidecar?.v !== 1 || typeof sidecar.file !== "string" || !ID.test(sidecar.file) || sidecar.meta?.key !== key) return undefined;
    return { path, sidecar };
  }

  async function writeTemp(tmp: string, body: BlobBody): Promise<{ size: number; etag: string }> {
    const hash = createHash("sha256");
    let size = 0;
    const fh = await open(tmp, "wx", 0o644);
    try {
      if (body instanceof ReadableStream) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          size += value.byteLength;
          await fh.write(value);
        }
      } else {
        const bytes = await toBytes(body);
        hash.update(bytes);
        size = bytes.byteLength;
        await fh.write(bytes);
      }
      await fh.datasync();
    } finally {
      await fh.close();
    }
    return { size, etag: hash.digest("hex").slice(0, 32) };
  }

  async function pruneEmptyDirs(from: string, stop: string) {
    for (let dir = dirname(from); dir !== stop && within(stop, dir); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        return;
      }
    }
  }

  // Bodies are lazy, sized Blobs over the data file (no handle is held until the body is read, and
  // runtimes keep Content-Length / use sendfile). Data files therefore outlive their sidecar briefly.
  async function openData(key: string): Promise<{ meta: BlobMeta; blob: Blob } | undefined> {
    const d = await dirs();
    // Retry once: an overwrite may retire the data file between reading the sidecar and opening it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await readSidecar(key);
      if (!found) return undefined;
      try {
        return { meta: found.sidecar.meta, blob: await openAsBlob(join(d.data, found.sidecar.file), { type: found.sidecar.meta.contentType }) };
      } catch (e) {
        if (!isCode(e, "ENOENT") || attempt === 1) throw e;
      }
    }
    return undefined;
  }

  const retainMs = opts.retainMs ?? 60_000;
  function retire(path: string): void {
    const remove = () => void unlink(path).catch(() => {});
    if (retainMs <= 0) return remove();
    const t = setTimeout(remove, retainMs) as unknown as { unref?: () => void };
    t.unref?.();
  }

  return {
    put(key, body, o = {}) {
      return locked(key, async () => {
        const { path, base } = await metaPath(key);
        const d = await dirs();
        const id = randomUUID();
        const tmpData = join(d.tmp, id);
        const tmpMeta = join(d.tmp, id + ".json");
        const dataPath = join(d.data, id);
        try {
          const { size, etag } = await writeTemp(tmpData, body);
          const parent = dirname(path);
          await mkdir(parent, { recursive: true });
          if (!within(base, await realpath(parent))) throw escapeError(key);
          const old = await readSidecar(key);
          const meta: BlobMeta = {
            key,
            size,
            contentType: o.contentType ?? "application/octet-stream",
            etag,
            uploadedAt: new Date(now()).toISOString(),
            ...(o.metadata ? { metadata: { ...o.metadata } } : {}),
          };
          await rename(tmpData, dataPath);
          const fh = await open(tmpMeta, "wx", 0o644);
          try {
            await fh.writeFile(JSON.stringify({ v: 1, file: id, meta } satisfies Sidecar));
            await fh.datasync();
          } finally {
            await fh.close();
          }
          await rename(tmpMeta, path); // commit point
          if (old) retire(join(d.data, old.sidecar.file));
          return structuredClone(meta);
        } catch (e) {
          await Promise.all([unlink(tmpData), unlink(tmpMeta), unlink(dataPath)].map((p) => p.catch(() => {})));
          throw e;
        }
      });
    },

    async get(key, o = {}) {
      const opened = await openData(key);
      if (!opened) return undefined;
      const { meta } = opened;
      let blob = opened.blob;
      if (o.range) {
        const start = Math.min(meta.size, Math.max(0, o.range.offset));
        const end = o.range.length === undefined ? meta.size : Math.min(meta.size, start + Math.max(0, o.range.length));
        blob = blob.slice(start, end, meta.contentType);
      }
      return { meta: structuredClone(meta), body: blob.stream(), blob };
    },

    async head(key) {
      return (await readSidecar(key))?.sidecar.meta;
    },

    delete(key) {
      return locked(key, async () => {
        const found = await readSidecar(key);
        if (!found) return false;
        const d = await dirs();
        try {
          await unlink(found.path);
        } catch (e) {
          if (isCode(e, "ENOENT")) return false;
          throw e;
        }
        retire(join(d.data, found.sidecar.file));
        await pruneEmptyDirs(found.path, d.meta);
        return true;
      });
    },

    async list(prefix = "", o = {}) {
      const d = await dirs();
      const limit = Math.min(Math.max(1, o.limit ?? 1000), 1000);
      // Walk only the directory the prefix pins down.
      const dirPart = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      let start = d.meta;
      if (dirPart) {
        try {
          start = resolve(d.meta, assertSafeKey(dirPart.slice(0, -1)));
        } catch {
          return { items: [] };
        }
        try {
          if (!within(d.meta, await realpath(start))) return { items: [] };
        } catch {
          return { items: [] };
        }
      }
      const keys: string[] = [];
      const walk = async (dir: string, rel: string) => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (e) {
          if (isCode(e, "ENOENT", "ENOTDIR")) return;
          throw e;
        }
        for (const ent of entries) {
          // Symlinks are neither files nor directories here, so they are never followed.
          if (ent.isDirectory()) await walk(join(dir, ent.name), rel + ent.name + "/");
          else if (ent.isFile() && ent.name.endsWith(".json")) {
            const key = rel + ent.name.slice(0, -5);
            if (key.startsWith(prefix) && (!o.cursor || key > o.cursor)) keys.push(key);
          }
        }
      };
      await walk(start, dirPart);
      keys.sort();

      const items: BlobMeta[] = [];
      let i = 0;
      for (; i < keys.length && items.length < limit; i++) {
        let meta: BlobMeta | undefined;
        try {
          meta = (await readSidecar(keys[i]!))?.sidecar.meta;
        } catch {
          meta = undefined;
        }
        if (meta) items.push(meta);
      }
      const more = i < keys.length;
      return { items, ...(more && items.length ? { cursor: items.at(-1)!.key } : {}) };
    },
  };
}
