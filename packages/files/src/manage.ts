// files().manage(): storage at a glance and per-file actions for operators (@miujs/admin renders
// it, checks permissions and audits every change). Never returns the signing secret or store
// credentials; download links are short-lived signed URLs.

import { t, type Context, type ManageSection, type ManageStat, type ManageValue } from "miujs";
import { Files, type FilesRuntime } from "./client.ts";
import { filesErrors } from "./errors.ts";
import { checkKey } from "./keys.ts";
import type { FileStore } from "./store.ts";

/** Status counts at most one page of this many files. */
export const USAGE_SCAN = 1000;
const SECRETISH = /secret|credential|password|token|key/i;

export interface FilesManageDeps {
  rt: FilesRuntime;
  store(): FileStore;
  multipart: boolean;
  /** A secret is configured (option or env); false means dev's random per-process secret or nothing. */
  hasSecret(ctx: Context): boolean;
  dev(): boolean;
}

export function filesManage(d: FilesManageDeps): ManageSection[] {
  const { rt } = d;
  const KeyInput = { key: t.string({ minLength: 1, maxLength: 1024 }) };

  return [
    {
      id: "files",
      title: "Files",
      description: "The file store, its usage and the files in it.",
      async status(ctx) {
        const st = rt.storeFor(ctx.env);
        const page = await st.list({ limit: USAGE_SCAN });
        const more = page.cursor !== undefined;
        const bytes = page.files.reduce((n, f) => n + f.size, 0);
        const scanned = more ? { hint: `Counted the first ${USAGE_SCAN} files only` } : {};
        const secret = d.hasSecret(ctx);
        const stats: ManageStat[] = [
          { label: "Store", value: d.store().kind },
          { label: "Files", value: more ? `${USAGE_SCAN}+` : page.files.length, ...scanned },
          { label: "Size", value: more ? `${bytes}+` : bytes, ...scanned },
          { label: "Max upload size", value: rt.maxUploadSize, hint: "Default limit for signed PUT uploads" },
          { label: "Multipart uploads", value: d.multipart },
          {
            label: "Signing secret",
            value: secret ? "set" : d.dev() ? "random (dev only)" : "missing",
            tone: secret ? "good" : d.dev() ? "warning" : "critical",
            ...(secret ? {} : { hint: "Set FILES_SECRET (32+ characters)" }),
          },
        ];
        for (const [k, v] of Object.entries(d.store().inspect?.() ?? {})) {
          if (SECRETISH.test(k) || (v !== null && typeof v === "object")) continue;
          stats.push({ label: `Store ${k}`, value: v as ManageValue });
        }
        return { stats };
      },
      lists: [
        {
          name: "files",
          title: "Files",
          idKey: "key",
          searchable: true,
          columns: [
            { key: "key", label: "Key", type: "code" },
            { key: "size", label: "Size", type: "bytes" },
            { key: "contentType", label: "Type" },
            { key: "uploaded", label: "Uploaded", type: "date" },
          ],
          async list(q, ctx) {
            // The search box is a key prefix: stores list by prefix, not by substring.
            const prefix = q.search?.trim() || undefined;
            const page = await rt.storeFor(ctx.env).list({ prefix, cursor: q.cursor, limit: Math.max(1, Math.min(100, Math.floor(q.limit) || 1)) });
            const rows = page.files.map((f) => ({ key: f.key, size: f.size, contentType: f.contentType, uploaded: f.uploaded.getTime() }));
            return page.cursor === undefined ? { rows } : { rows, next: page.cursor };
          },
          rowActions: [
            {
              name: "delete",
              title: "Delete file",
              description: "Deletes the file from the store. This cannot be undone.",
              danger: true,
              input: t.object(KeyInput),
              async run({ key }: { key: string }, ctx: Context) {
                checkKey(key);
                const st = rt.storeFor(ctx.env);
                if (!(await st.head(key))) return `${key} was already gone`;
                await st.delete(key);
                return `Deleted ${key}`;
              },
            },
            {
              name: "downloadLink",
              title: "Get a download link",
              description: "A signed URL that downloads the file until it expires (default 5 minutes). Anyone with the link can use it.",
              input: t.object({ ...KeyInput, expiresIn: t.optional(t.integer({ min: 10, max: 3600, description: "Seconds until the link stops working" })) }),
              async run({ key, expiresIn }: { key: string; expiresIn?: number }, ctx: Context) {
                checkKey(key);
                if (!(await rt.storeFor(ctx.env).head(key))) throw filesErrors.notFound(key);
                const seconds = expiresIn ?? 300;
                const name = key.slice(key.lastIndexOf("/") + 1);
                const url = await new Files(ctx, rt).signedUrl(key, { expiresIn: seconds, download: name });
                return { url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
              },
            },
          ],
        },
      ],
      settings: {
        schema: t.object({ maxUploadSize: t.integer({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "Bytes. Default limit for signed PUT uploads that do not set maxSize." }) }),
        get: () => ({ maxUploadSize: rt.maxUploadSize }),
        set(v: { maxUploadSize: number }) {
          rt.maxUploadSize = v.maxUploadSize;
        },
      },
    },
  ];
}
