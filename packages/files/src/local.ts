// Local-disk store for Bun and Node. node:* modules are imported lazily through a variable
// specifier, so bundlers never pull them into a Workers build (AGENTS.md rule 3).
import { detectRuntime, MiuError } from "miujs";
import { filesErrors } from "./errors.ts";
import { checkKey } from "./keys.ts";
import { copyInfo, pageOf } from "./memory.ts";
import { DEFAULT_TYPE, randomHex, type ByteRange, type FileObject, type FileStore, type StoredFile, type StorePutOptions, type UploadedPart } from "./store.ts";

type Fs = typeof import("node:fs/promises");
type Path = typeof import("node:path");
type FileHandle = Awaited<ReturnType<Fs["open"]>>;

interface Meta {
  size: number;
  etag: string;
  contentType: string;
  metadata: Record<string, string>;
  uploaded: string;
}

/** Throws unless file-system access is available (Bun or Node). */
export function assertFsRuntime(runtime: string): void {
  if (runtime !== "bun" && runtime !== "node") throw filesErrors.runtime("localStore", runtime);
}

// Names Windows treats as devices or silently rewrites; rejected everywhere so a directory of
// files can move between machines.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const ETAG = /^[0-9a-f]{32}$/;

function checkLocalKey(key: string): string {
  checkKey(key);
  for (const seg of key.split("/")) {
    if (WINDOWS_RESERVED.test(seg)) throw filesErrors.keyInvalid(key, `"${seg}" is a reserved device name on Windows`);
    if (seg.endsWith(".") || seg.endsWith(" ")) throw filesErrors.keyInvalid(key, "a segment ends with '.' or a space");
  }
  return key;
}

const isCode = (err: unknown, ...codes: string[]) => codes.includes((err as { code?: string })?.code ?? "");

let modules: Promise<{ fs: Fs; path: Path }> | undefined;
function load(): Promise<{ fs: Fs; path: Path }> {
  return (modules ??= (async () => {
    assertFsRuntime(detectRuntime());
    const fsName = "node:fs/promises";
    const pathName = "node:path";
    const [fs, path] = await Promise.all([import(/* @vite-ignore */ fsName), import(/* @vite-ignore */ pathName)]);
    return { fs: fs as Fs, path: path as Path };
  })());
}

// Read size per pull. 256 KiB measured ~1.8x faster than 64 KiB for large downloads.
const CHUNK = 256 * 1024;

function fileStream(handle: FileHandle, start: number, length: number): ReadableStream<Uint8Array> {
  let pos = start;
  const end = start + length;
  const close = () => handle.close().catch(() => {});
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const want = Math.min(CHUNK, end - pos);
        if (want <= 0) {
          await close();
          return c.close();
        }
        const buf = new Uint8Array(want);
        const { bytesRead } = await handle.read(buf, 0, want, pos);
        if (bytesRead === 0) {
          await close();
          return c.close();
        }
        pos += bytesRead;
        c.enqueue(bytesRead === want ? buf : buf.subarray(0, bytesRead));
      } catch (err) {
        await close();
        c.error(err);
      }
    },
    cancel: close,
  });
}

/**
 * Files on the local disk, under `dir`: `objects/<key>` holds the bytes, `meta/<key>.json` the
 * content type, etag and metadata (written last, so it is the commit point). Writes go to
 * `tmp/` and are renamed into place, so readers never see a half-written file.
 *
 * Bun and Node only: other runtimes get MIU_E_FILES_RUNTIME on first use.
 */
export function localStore(dir: string): FileStore {
  if (typeof dir !== "string" || dir === "") {
    throw filesErrors.config("CONFIG", "localStore needs a directory", 'Pass a directory, e.g. localStore("./data/files").');
  }

  const paths = async () => {
    const { fs, path } = await load();
    const root = path.resolve(dir);
    return { fs, path, root, objects: path.join(root, "objects"), meta: path.join(root, "meta"), tmp: path.join(root, "tmp"), mp: path.join(root, "multipart") };
  };

  /** Absolute path of `key` under `base`, verified to stay inside it. */
  const inside = (path: Path, base: string, key: string, suffix = ""): string => {
    const p = path.resolve(base, ...key.split("/")) + suffix;
    if (!p.startsWith(base + path.sep)) throw filesErrors.keyInvalid(key, "resolves outside the store directory");
    return p;
  };

  const readMeta = async (key: string): Promise<StoredFile | null> => {
    const { fs, path, meta } = await paths();
    try {
      const m = JSON.parse(await fs.readFile(inside(path, meta, key, ".json"), "utf8")) as Meta;
      return { key, size: m.size, etag: m.etag, contentType: m.contentType, metadata: m.metadata ?? {}, uploaded: new Date(m.uploaded) };
    } catch (err) {
      if (isCode(err, "ENOENT", "ENOTDIR")) return null;
      throw err;
    }
  };

  /** Write the stream to a fresh temp file; delete it if anything fails. */
  const writeTemp = async (body: ReadableStream<Uint8Array>): Promise<{ file: string; size: number }> => {
    const { fs, path, tmp } = await paths();
    const file = path.join(tmp, randomHex());
    let handle: FileHandle;
    try {
      await fs.mkdir(tmp, { recursive: true });
      handle = await fs.open(file, "wx");
    } catch (err) {
      await body.cancel(err).catch(() => {});
      throw err;
    }
    let size = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.byteLength) off += (await handle.write(value, off, value.byteLength - off)).bytesWritten;
        size += value.byteLength;
      }
      await handle.close();
    } catch (err) {
      // Release the body too: a disk error must not leave the client (or a part file) half-read and open.
      await reader.cancel(err).catch(() => {});
      await handle.close().catch(() => {});
      await fs.rm(file, { force: true });
      throw err;
    }
    return { file, size };
  };

  /** Move a finished temp file to `key` and write its metadata (the commit point). */
  const commit = async (key: string, tmpFile: string, size: number, opts: StorePutOptions): Promise<StoredFile> => {
    const { fs, path, objects, meta, tmp } = await paths();
    const dest = inside(path, objects, key);
    const metaFile = inside(path, meta, key, ".json");
    const m: Meta = { size, etag: randomHex(), contentType: opts.contentType || DEFAULT_TYPE, metadata: { ...opts.metadata }, uploaded: new Date().toISOString() };
    const metaTmp = path.join(tmp, randomHex());
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.mkdir(path.dirname(metaFile), { recursive: true });
      await fs.writeFile(metaTmp, JSON.stringify(m), { flag: "wx" });
      await fs.rename(tmpFile, dest);
      await fs.rename(metaTmp, metaFile);
    } catch (err) {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(metaTmp, { force: true });
      if (isCode(err, "EEXIST", "ENOTDIR", "EISDIR", "EPERM", "ENOTEMPTY")) {
        throw new MiuError({
          code: "MIU_E_FILES_KEY_CONFLICT",
          status: 409,
          message: `Key ${JSON.stringify(key)} collides with an existing file or folder on disk`,
          fix: 'On the local store a key cannot be both a file and a "folder" prefix of other keys (e.g. "a" and "a/b"). Use distinct keys such as "a/index".',
        });
      }
      throw err;
    }
    return { key, size: m.size, etag: m.etag, contentType: m.contentType, metadata: m.metadata, uploaded: new Date(m.uploaded) };
  };

  const uploadDir = async (key: string, id: string): Promise<{ dir: string; info: { key: string } & StorePutOptions }> => {
    const { fs, path, mp } = await paths();
    if (typeof id !== "string" || !UPLOAD_ID.test(id)) throw filesErrors.uploadNotFound();
    const d = path.join(mp, id);
    try {
      const info = JSON.parse(await fs.readFile(path.join(d, "upload.json"), "utf8"));
      if (info.key !== key) throw filesErrors.uploadNotFound();
      return { dir: d, info };
    } catch (err) {
      if (isCode(err, "ENOENT")) throw filesErrors.uploadNotFound();
      throw err;
    }
  };

  const walk = async (fs: Fs, path: Path, base: string, rel: string, out: string[]): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(base, rel), { withFileTypes: true });
    } catch (err) {
      if (isCode(err, "ENOENT")) return;
      throw err;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(fs, path, base, r, out);
      else if (e.name.endsWith(".json")) out.push(r.slice(0, -5));
    }
  };

  return {
    kind: "local",
    async put(key, body, opts = {}) {
      checkLocalKey(key);
      const { file, size } = await writeTemp(body);
      return commit(key, file, size, opts);
    },
    async get(key, opts: { range?: ByteRange } = {}): Promise<FileObject | null> {
      checkLocalKey(key);
      const info = await readMeta(key);
      if (!info) return null;
      const { fs, path, objects } = await paths();
      let handle: FileHandle;
      try {
        handle = await fs.open(inside(path, objects, key), "r");
      } catch (err) {
        if (isCode(err, "ENOENT", "ENOTDIR")) return null;
        throw err;
      }
      const r = opts.range;
      if (!r) return { ...info, body: fileStream(handle, 0, info.size) };
      const offset = Math.min(r.offset, info.size);
      const length = Math.min(r.length, info.size - offset);
      return { ...info, body: fileStream(handle, offset, length), range: { offset, length } };
    },
    async head(key) {
      checkLocalKey(key);
      return readMeta(key);
    },
    async delete(key) {
      checkLocalKey(key);
      const { fs, path, objects, meta } = await paths();
      // Metadata first: once it is gone the object is invisible, even if the unlink below fails.
      await fs.rm(inside(path, meta, key, ".json"), { force: true });
      await fs.rm(inside(path, objects, key), { force: true });
    },
    async list(opts = {}) {
      const { fs, path, meta } = await paths();
      const keys: string[] = [];
      await walk(fs, path, meta, "", keys);
      const page = pageOf(keys, opts);
      const files: StoredFile[] = [];
      for (const k of page.keys) {
        const info = await readMeta(k);
        if (info) files.push(copyInfo(info));
      }
      return { files, cursor: page.cursor };
    },
    async createMultipart(key, opts = {}) {
      checkLocalKey(key);
      const { fs, path, mp } = await paths();
      const id = randomHex();
      const d = path.join(mp, id);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, "upload.json"), JSON.stringify({ key, contentType: opts.contentType, metadata: opts.metadata ?? {} }));
      return id;
    },
    async uploadPart(key, id, partNumber, body): Promise<UploadedPart> {
      checkLocalKey(key);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw filesErrors.partInvalid(partNumber);
      const { dir: d } = await uploadDir(key, id);
      const { fs, path } = await paths();
      const { file } = await writeTemp(body);
      const etag = randomHex();
      try {
        for (const name of await fs.readdir(d)) if (name.startsWith(`${partNumber}.`)) await fs.rm(path.join(d, name), { force: true });
        await fs.rename(file, path.join(d, `${partNumber}.${etag}`));
      } catch (err) {
        await fs.rm(file, { force: true });
        if (isCode(err, "ENOENT")) throw filesErrors.uploadNotFound(); // aborted meanwhile
        throw err;
      }
      return { partNumber, etag };
    },
    async completeMultipart(key, id, parts) {
      checkLocalKey(key);
      const { dir: d, info } = await uploadDir(key, id);
      const { fs, path } = await paths();
      const files: string[] = [];
      for (const p of parts) {
        if (!Number.isInteger(p?.partNumber) || typeof p.etag !== "string" || !ETAG.test(p.etag)) throw filesErrors.partInvalid(p?.partNumber);
        const f = path.join(d, `${p.partNumber}.${p.etag}`);
        try {
          await fs.access(f);
        } catch {
          throw filesErrors.partInvalid(p.partNumber);
        }
        files.push(f);
      }
      // Concatenate the parts into one temp file, streaming.
      let i = 0;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const joined = new ReadableStream<Uint8Array>({
        async pull(c) {
          for (;;) {
            if (!reader) {
              if (i >= files.length) return c.close();
              const h = await fs.open(files[i++], "r");
              let size: number;
              try {
                size = (await h.stat()).size;
              } catch (err) {
                await h.close().catch(() => {});
                throw err;
              }
              reader = fileStream(h, 0, size).getReader();
            }
            const { done, value } = await reader.read();
            if (!done) return c.enqueue(value);
            reader = null;
          }
        },
        // writeTemp cancels on a write error: close the part file being read.
        cancel: (reason) => reader?.cancel(reason),
      });
      const { file, size } = await writeTemp(joined);
      const out = await commit(key, file, size, { contentType: info.contentType, metadata: info.metadata });
      await fs.rm(d, { recursive: true, force: true });
      return out;
    },
    async abortMultipart(key, id) {
      checkLocalKey(key);
      try {
        const { dir: d } = await uploadDir(key, id);
        const { fs } = await paths();
        await fs.rm(d, { recursive: true, force: true });
      } catch (err) {
        if ((err as MiuError)?.code !== "MIU_E_FILES_UPLOAD_NOT_FOUND") throw err;
      }
    },
    inspect: () => ({ dir }),
  };
}
