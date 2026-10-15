// The tool-use loop behind `ai.run()`: ask the model, run the tools it calls, feed the results
// back, until it answers or a limit (steps, tokens, wall time) is reached.

import type { App } from "miujs";
import { DEFAULT_MAX_TOKENS, type GenerateOptions, type Internals } from "./client.ts";
import { execute, isToolSource, specOf, type AITool, type ToolInput } from "./tools.ts";
import type { AIMessage, AIPart, GenerateResult, StopReason, Usage } from "./types.ts";

export interface RunOptions extends Omit<GenerateOptions, "tools"> {
  /** Tools (`tool()`) and tool sources (`appTools()`). */
  tools: ToolInput[];
  /** Model calls before giving up. Default 10. */
  maxSteps?: number;
  limits?: {
    /** Stop once input+output tokens across all steps reach this. */
    totalTokens?: number;
    /** Stop once this many milliseconds have passed (checked between steps; aborts a model call in flight). */
    timeMs?: number;
  };
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  ms: number;
}

export interface RunResult {
  /** The final answer (the last model turn's text). */
  text: string;
  /** The model's stop reason, or which limit ended the run. */
  stopReason: StopReason | "max_steps" | "token_limit" | "time_limit";
  /** Model calls made. */
  steps: number;
  usage: Usage;
  toolCalls: ToolCallRecord[];
  /** Every message: the input, assistant turns and tool results. */
  transcript: AIMessage[];
}

export const DEFAULT_MAX_STEPS = 10;

export async function runLoop(it: Internals, o: RunOptions, app: App | undefined): Promise<RunResult> {
  const { tools: inputs = [], maxSteps = DEFAULT_MAX_STEPS, limits = {}, ...gen } = o;
  const { scope } = it;
  const tools = new Map<string, AITool>();
  for (const t of inputs) {
    const list = isToolSource(t) ? await t.resolve({ ctx: scope.ctx, env: scope.env, app }) : [t];
    for (const x of list) tools.set(x.name, x);
  }
  const specs = [...tools.values()].map(specOf);
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const timeUp = () => limits.timeMs !== undefined && elapsed() >= limits.timeMs;

  const transcript: AIMessage[] = [...it.request(gen, DEFAULT_MAX_TOKENS).messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const records: ToolCallRecord[] = [];
  let text = "";
  const done = (stopReason: RunResult["stopReason"], steps: number): RunResult => ({ text, stopReason, steps, usage, toolCalls: records, transcript });

  for (let step = 1; step <= maxSteps; step++) {
    if (timeUp()) return done("time_limit", step - 1);
    let signal = gen.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (limits.timeMs !== undefined) {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(new DOMException("run time limit", "TimeoutError")), Math.max(0, limits.timeMs - elapsed()));
      signal = gen.signal ? AbortSignal.any([gen.signal, ctrl.signal]) : ctrl.signal;
    }
    let out: GenerateResult;
    const t0 = performance.now();
    try {
      const req = it.request({ ...gen, messages: transcript, prompt: undefined, signal }, DEFAULT_MAX_TOKENS);
      if (specs.length) req.tools = specs;
      out = await it.opts.provider.generate(req, it.runtime());
    } catch (err) {
      if (timeUp() && !gen.signal?.aborted) return done("time_limit", step);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    it.logUsage("run", out.model, out.usage, t0);
    usage.inputTokens += out.usage.inputTokens;
    usage.outputTokens += out.usage.outputTokens;
    transcript.push(out.message);
    text = out.text;

    // Only a turn that ended to call tools runs them (not one cut off by max_tokens or a refusal).
    if (out.stopReason !== "tool_use" || out.toolCalls.length === 0) return done(out.stopReason, step);
    if (limits.totalTokens !== undefined && usage.inputTokens + usage.outputTokens >= limits.totalTokens) return done("token_limit", step);

    // Parallel calls run concurrently; all results go back in one message, in call order.
    const tc = { ctx: scope.ctx, env: scope.env, signal: gen.signal };
    const ran = await Promise.all(
      out.toolCalls.map(async (call) => {
        const s = performance.now();
        const r = await execute(tools, call.name, call.args, tc);
        return { call, r, ms: Math.round(performance.now() - s) };
      }),
    );
    const results: AIPart[] = [];
    for (const { call, r, ms } of ran) {
      records.push({ id: call.id, name: call.name, args: call.args, result: r.content, isError: r.isError, ms });
      results.push({ type: "tool_result", id: call.id, name: call.name, content: r.content, ...(r.isError ? { isError: true } : {}) });
    }
    transcript.push({ role: "user", content: results });
  }
  return done("max_steps", maxSteps);
}
