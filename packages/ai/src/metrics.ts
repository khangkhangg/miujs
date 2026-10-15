// In-memory usage counters for the operator view (`ai().manage()`). Per process (per isolate on
// Workers), bounded, and free of prompts, replies, keys and provider error messages.

import { isMiuError } from "miujs";
import type { Usage } from "./types.ts";

/** Models tracked one by one; the rest are summed under "(other)". */
export const MAX_MODELS = 20;
export const OTHER = "(other)";

export interface ModelCounters {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
}

export class AIMetrics {
  /** Completed model calls (generate, stream, object, each run() step). */
  requests = 0;
  inputTokens = 0;
  outputTokens = 0;
  errors = 0;
  toolCalls = 0;
  toolErrors = 0;
  embedCalls = 0;
  lastError: { code: string; at: number } | null = null;
  private models = new Map<string, ModelCounters>();

  usage(model: string, u: Usage): void {
    this.requests++;
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
    const m = this.model(model);
    m.requests++;
    m.inputTokens += u.inputTokens;
    m.outputTokens += u.outputTokens;
  }

  embed(): void {
    this.embedCalls++;
  }

  tool(isError: boolean): void {
    this.toolCalls++;
    if (isError) this.toolErrors++;
  }

  /** Only the error code (or name) is kept: provider messages may echo request content. */
  error(model: string | undefined, err: unknown): void {
    this.errors++;
    const code = isMiuError(err) ? err.code : err instanceof Error ? err.name : "Error";
    this.lastError = { code, at: Date.now() };
    if (model) this.model(model).errors++;
  }

  byModel(): ModelCounters[] {
    return [...this.models.values()].map((m) => ({ ...m }));
  }

  private model(name: string): ModelCounters {
    let m = this.models.get(name);
    if (!m) {
      const key = this.models.size >= MAX_MODELS ? OTHER : name;
      m = this.models.get(key);
      if (!m) this.models.set(key, (m = { model: key, requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 }));
    }
    return m;
  }
}
