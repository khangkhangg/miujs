import { MiuError } from "miujs";

const show = (v: unknown) => JSON.stringify(v) ?? String(v);

/** Every error @miujs/tour throws. Codes are stable; messages and fixes may improve. */
export const tourErrors = {
  config: (code: string, message: string, fix: string, details?: unknown) => new MiuError({ code: `MIU_E_TOUR_${code}`, status: 500, message, fix, details }),

  notFound: (ref: string) =>
    new MiuError({
      code: "MIU_E_TOUR_NOT_FOUND",
      status: 404,
      message: `Tour ${show(ref)} not found`,
      fix: "Use a tour id (tour_...) or slug from GET /tours. Draft and private tours are hidden from viewers who cannot open them.",
    }),

  sceneNotFound: (id: string) =>
    new MiuError({ code: "MIU_E_TOUR_SCENE_NOT_FOUND", status: 404, message: `Scene ${show(id)} not found in this tour`, fix: "Use a scene id from GET /tours/:tour (scenes[].id)." }),

  hotspotNotFound: (id: string) =>
    new MiuError({ code: "MIU_E_TOUR_HOTSPOT_NOT_FOUND", status: 404, message: `Hotspot ${show(id)} not found in this tour`, fix: "Use a hotspot id from GET /tours/:tour (scenes[].hotspots[].id)." }),

  floorPlanNotFound: (floor: number) =>
    new MiuError({ code: "MIU_E_TOUR_FLOORPLAN_NOT_FOUND", status: 404, message: `No floor plan for floor ${floor}`, fix: "Create it with PUT /tours/:tour/floorplans/:floor." }),

  assetNotFound: (id: string) =>
    new MiuError({ code: "MIU_E_TOUR_ASSET_NOT_FOUND", status: 404, message: `Asset ${show(id)} not found`, fix: "Use an asset id from GET /tours/:tour/assets." }),

  slugTaken: (slug: string) =>
    new MiuError({ code: "MIU_E_TOUR_SLUG_TAKEN", status: 409, message: `The slug ${show(slug)} is already used by another tour`, fix: "Pick a different slug, e.g. add the street number or a short suffix." }),

  invalid: (message: string, fix: string, details?: unknown) => new MiuError({ code: "MIU_E_TOUR_INVALID", status: 400, message, fix, details }),

  tokenInvalid: (why: string) =>
    new MiuError({
      code: "MIU_E_TOUR_TOKEN_INVALID",
      status: 403,
      message: `Invalid tour token: ${why}`,
      fix: "Ask the tour owner for a fresh share link, or open the tour again from its page. Tokens cannot be edited.",
    }),

  tokenExpired: () =>
    new MiuError({ code: "MIU_E_TOUR_TOKEN_EXPIRED", status: 403, message: "This tour link has expired", fix: "Ask the tour owner for a new share link (POST /tours/:tour/share), or reload the tour page." }),

  locked: (slug: string) =>
    new MiuError({
      code: "MIU_E_TOUR_LOCKED",
      status: 401,
      message: `Tour ${show(slug)} needs a password or a share link`,
      fix: `POST /tours/${slug}/unlock with {"password": "..."}, or open the share link you were given.`,
    }),

  passwordWrong: () => new MiuError({ code: "MIU_E_TOUR_PASSWORD_WRONG", status: 403, message: "Wrong tour password", fix: "Check the password with the tour owner." }),

  secretMissing: () =>
    new MiuError({
      code: "MIU_E_TOUR_SECRET_MISSING",
      status: 500,
      message: "No secret for signing tour links",
      fix: "Set TOUR_SECRET (32+ random characters; FILES_SECRET or SESSION_SECRET also work), or pass tour({ secret }).",
    }),

  secretWeak: () =>
    new MiuError({ code: "MIU_E_TOUR_SECRET_WEAK", status: 500, message: "The tour secret is shorter than 32 characters", fix: "Use 32+ random characters, e.g. `openssl rand -base64 32`." }),

  filesMissing: () =>
    new MiuError({
      code: "MIU_E_TOUR_FILES_MISSING",
      status: 500,
      message: "@miujs/tour needs ctx.files from @miujs/files",
      fix: "Add files({ store }) to miu({ plugins }) and pass the same store to tour({ store }).",
    }),

  queueMissing: () =>
    new MiuError({
      code: "MIU_E_TOUR_QUEUE_MISSING",
      status: 500,
      message: "Tour assets are processed by queue jobs, but no queue plugin is installed",
      fix: "Add queue({ jobs: tourPlugin.jobs.all }) from @miujs/queue to miu({ plugins }).",
    }),

  jobsNotRegistered: (missing: string[]) =>
    new MiuError({
      code: "MIU_E_TOUR_JOBS_NOT_REGISTERED",
      status: 500,
      message: `The queue plugin does not run the tour jobs: ${missing.join(", ")}`,
      fix: "Pass them to the queue: queue({ jobs: [...yourJobs, ...tourPlugin.jobs.all] }).",
    }),

  processorMissing: (step: string) =>
    new MiuError({
      code: "MIU_E_TOUR_PROCESSOR_MISSING",
      status: 500,
      message: `No processor can ${step}`,
      fix: "Pass one to tour({ processors: [...] }): vipsProcessor() / gltfTransformProcessor() on a server or container, cloudflareImagesProcessor() or externalProcessor() from Workers.",
    }),

  processorUnavailable: (name: string, tool: string, fix: string) =>
    new MiuError({ code: "MIU_E_TOUR_PROCESSOR_UNAVAILABLE", status: 500, message: `Processor "${name}" cannot run: ${tool} is not available here`, fix }),

  processorFailed: (name: string, message: string, details?: unknown) =>
    new MiuError({
      code: "MIU_E_TOUR_PROCESSOR_FAILED",
      status: 502,
      message: `Processor "${name}" failed: ${message}`,
      fix: "Check the processor's logs and the source file; retry with POST /tours/:tour/assets/:assetId/retry.",
      details,
    }),

  resultInvalid: (name: string, why: string) =>
    new MiuError({
      code: "MIU_E_TOUR_PROCESSOR_RESULT_INVALID",
      status: 502,
      message: `Processor "${name}" returned an invalid result: ${why}`,
      fix: "Return keys under the outputPrefix you were given, with the fields documented on PanoramaResult / ModelResult.",
    }),

  sourceMissing: (key: string) =>
    new MiuError({
      code: "MIU_E_TOUR_SOURCE_MISSING",
      status: 404,
      message: `Source file ${show(key)} is not in the tour's file store`,
      fix: "Upload it first, and pass the same store to files({ store }) and tour({ store }) so jobs can read what requests stored.",
    }),

  assetType: (sceneType: string, detected: string, allowed: string[]) =>
    new MiuError({
      code: "MIU_E_TOUR_ASSET_TYPE",
      status: 415,
      message: `A ${sceneType} scene cannot use a ${detected} file`,
      fix: `Upload one of: ${allowed.join(", ")} (detected from the file's bytes).`,
      details: { detected, allowed },
    }),

  callbackInvalid: () =>
    new MiuError({
      code: "MIU_E_TOUR_CALLBACK_INVALID",
      status: 401,
      message: "Processor callback signature is missing, wrong or too old",
      fix: "Sign the exact body: header x-miu-tour-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`> with the externalProcessor secret. Clocks must agree within 5 minutes.",
    }),

  strictCdn: () =>
    new MiuError({
      code: "MIU_E_TOUR_STRICT_CDN",
      status: 500,
      message: 'This tour uses privacy: "strict", which forbids third-party CDNs, but the viewer is configured to load from a CDN',
      fix: 'Vendor the viewer files (see the @miujs/tour README, "Self-hosting the viewer"), serve them with staticFiles(), and pass tour({ viewerAssets: { basePath: "/vendor/tour" } }).',
    }),

  liveMissing: () =>
    new MiuError({
      code: "MIU_E_TOUR_LIVE_MISSING",
      status: 500,
      message: "Live guided tours need the realtime rooms plugin",
      fix: "const live = rooms({ rooms: [guidedTour] }); then miu({ plugins: [live, tour({ live, ... })] }).",
    }),

  rateLimited: (retryAfter: number) =>
    new MiuError({
      code: "MIU_E_TOUR_RATE_LIMITED",
      status: 429,
      message: "Too many analytics events",
      fix: `Batch events (up to 50 per request) and send at most a few requests per minute. Retry after ${retryAfter} seconds.`,
      details: { retryAfter },
    }),

  analyticsDisabled: () =>
    new MiuError({ code: "MIU_E_TOUR_ANALYTICS_DISABLED", status: 404, message: "Analytics are turned off for these tours", fix: "Remove analytics: false from tour({ ... }) to collect events." }),

  guideToken: () =>
    new MiuError({ code: "MIU_E_TOUR_GUIDE_TOKEN", status: 403, message: "That guide token is not valid for this live tour", fix: "Open the guide link from POST /tours/:tour/live (the part after #guide=), or start a new live tour." }),

  guideOnly: () =>
    new MiuError({ code: "MIU_E_TOUR_GUIDE_ONLY", status: 403, message: "Only the guide can do that", fix: "Join as the guide with the guide link (it carries #guide=<token>), or follow along." }),
};
