import { isMiuError } from "miujs";
import type { StreamEvent } from "./types.ts";

/**
 * Turns `ctx.ai.stream(...)` into a `text/event-stream` Response. Each delta is an event named
 * after its type (`text`, `tool_call`, `finish`) with the JSON event as data; failures send an
 * `error` event with the MiuError JSON. Provider-internal content (e.g. thinking signatures)
 * is not sent.
 *
 * ```ts
 * route.post("/chat", { handler: ({ ai, body }) => toSSE(ai.stream({ prompt: body.q })) })
 * ```
 */
export function toSSE(stream: AsyncIterable<StreamEvent>, init: { headers?: HeadersInit } = {}): Response {
  const enc = new TextEncoder();
  const frame = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let iter: AsyncIterator<StreamEvent> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      iter ??= stream[Symbol.asyncIterator]();
      try {
        const { value, done } = await iter.next();
        if (cancelled) return;
        if (done) return controller.close();
        if (value.type === "finish") {
          const { message: _m, ...rest } = value;
          controller.enqueue(frame("finish", rest));
        } else {
          controller.enqueue(frame(value.type, value));
        }
      } catch (err) {
        // After a cancel the pending read fails with the abort: nobody is listening any more.
        if (cancelled) return;
        const payload = isMiuError(err) ? err.toJSON() : { error: { code: "MIU_E_INTERNAL", message: "Stream failed" } };
        controller.enqueue(frame("error", payload));
        controller.close();
      }
    },
    async cancel() {
      // The client went away: stop the model call (ctx.ai streams abort their HTTP request here).
      cancelled = true;
      await iter?.return?.();
    },
  });
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  headers.set("x-accel-buffering", "no");
  return new Response(body, { headers });
}
