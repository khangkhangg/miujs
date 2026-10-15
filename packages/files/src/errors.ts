import { MiuError } from "miujs";

const show = (v: unknown) => JSON.stringify(v) ?? String(v);

/** Every error @miujs/files throws. Codes are stable; messages and fixes may improve. */
export const filesErrors = {
  config: (code: string, message: string, fix: string) => new MiuError({ code: `MIU_E_FILES_${code}`, status: 500, message, fix }),

  keyInvalid: (key: unknown, why: string) =>
    new MiuError({
      code: "MIU_E_FILES_KEY_INVALID",
      status: 400,
      message: `Invalid file key ${show(key)}: ${why}`,
      fix: "Use a relative key of '/'-separated segments such as `avatars/${userId}.png`: no leading '/', no '.' or '..' segments, no empty segments, no backslashes, control characters or ':' (max 1024 bytes).",
    }),

  notFound: (key: string) =>
    new MiuError({
      code: "MIU_E_FILES_NOT_FOUND",
      status: 404,
      message: `File ${show(key)} not found`,
      fix: "Check the key, or upload the file first with ctx.files.put().",
    }),

  tooLarge: (limit: number) =>
    new MiuError({
      code: "MIU_E_FILES_TOO_LARGE",
      status: 413,
      message: `File is larger than the ${limit}-byte limit`,
      fix: `Send at most ${limit} bytes, or raise \`maxSize\` on the server. Large 3D/360° assets should use the resumable multipart upload routes.`,
      details: { maxSize: limit },
    }),

  typeNotAllowed: (got: string | null, allowed: string[]) =>
    new MiuError({
      code: "MIU_E_FILES_TYPE_NOT_ALLOWED",
      status: 415,
      message: got ? `File type ${got} is not allowed` : "File type could not be recognized from its contents",
      fix: `Upload one of: ${allowed.join(", ")}. The type is detected from the file's bytes, not its name or the client's content-type.`,
      details: { detected: got, allowed },
    }),

  tokenInvalid: (why: string) =>
    new MiuError({
      code: "MIU_E_FILES_TOKEN_INVALID",
      status: 403,
      message: `Invalid file token: ${why}`,
      fix: "Request a fresh URL from the server (ctx.files.signedUrl). Signed URLs cannot be edited, and only work for the method they were signed for.",
    }),

  tokenExpired: () =>
    new MiuError({
      code: "MIU_E_FILES_TOKEN_EXPIRED",
      status: 403,
      message: "This file URL has expired",
      fix: "Request a fresh URL from the server, or sign it with a longer `expiresIn`.",
    }),

  secretMissing: () =>
    new MiuError({
      code: "MIU_E_FILES_SECRET_MISSING",
      status: 500,
      message: "No secret configured for signing file URLs",
      fix: "Set FILES_SECRET (or SESSION_SECRET) to a random string of 32+ characters (on Workers: `wrangler secret put FILES_SECRET`), or pass files({ secret }).",
    }),

  secretWeak: () =>
    new MiuError({
      code: "MIU_E_FILES_SECRET_WEAK",
      status: 500,
      message: "The file-signing secret is shorter than 32 characters",
      fix: "Use a random secret of 32+ characters, e.g. the output of `openssl rand -base64 48`.",
    }),

  storeMissing: () =>
    new MiuError({
      code: "MIU_E_FILES_STORE_MISSING",
      status: 500,
      message: "files() has no store configured in production",
      fix: "Pass a store: files({ store: r2Store(\"FILES\") }) on Workers or files({ store: localStore(\"./data/files\") }) on a server. The in-memory default is for development only.",
    }),

  runtime: (what: string, runtime: string) =>
    new MiuError({
      code: "MIU_E_FILES_RUNTIME",
      status: 500,
      message: `${what} is not available on ${runtime}`,
      fix: "localStore needs Bun or Node file-system access. On Cloudflare Workers use r2Store(\"FILES\"); elsewhere use memoryStore() or a custom store.",
    }),

  binding: (name: string) =>
    new MiuError({
      code: "MIU_E_FILES_BINDING",
      status: 500,
      message: `R2 binding ${show(name)} is not available in env`,
      fix: `Add an R2 bucket binding named "${name}" to wrangler.toml ([[r2_buckets]] binding = "${name}" bucket_name = "..."), or pass a different name to r2Store().`,
    }),

  badRequest: (code: string, message: string, fix: string, status = 400) => new MiuError({ code: `MIU_E_FILES_${code}`, status, message, fix }),

  partInvalid: (partNumber: unknown) =>
    new MiuError({
      code: "MIU_E_FILES_PART_INVALID",
      status: 400,
      message: `Part ${show(partNumber)} is missing or its etag does not match`,
      fix: "Send `parts` as the { partNumber, etag } pairs returned by each part upload, in order. Re-upload any part that failed.",
    }),

  uploadNotFound: () =>
    new MiuError({
      code: "MIU_E_FILES_UPLOAD_NOT_FOUND",
      status: 404,
      message: "Multipart upload not found (completed, aborted or expired)",
      fix: "Start a new upload with POST {basePath}/uploads.",
    }),
};
