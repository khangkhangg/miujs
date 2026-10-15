// Workflow builder logic: the editor works on the JSON spec itself (the same shape
// @miujs/workflows' fromJson/validateSpec take), addressed by the dotted paths validateSpec
// reports ("steps.1.then.0"). Every operation returns a new spec. Self-contained (see filters.ts).

export interface FlatStep {
  path: string;
  step: Record<string, any>;
  depth: number;
  branch: "then" | "else" | null;
}

export interface DropTarget {
  parent: string;
  index: number;
  depth: number;
}

export interface StepIssue {
  /** Path inside the step ("duration", "params.url"), or the whole path for spec-level issues. */
  field: string;
  message: string;
  fix: string;
}

export type WorkflowLib = ReturnType<typeof workflowLib>;

export function workflowLib() {
  type Spec = { steps: any[] };
  type FullSpec = { name: string; description?: string; trigger: any; steps: any[]; concurrency?: any };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  function walkIds(steps: Record<string, any>[], out: string[]) {
    for (const s of steps || []) {
      if (s && typeof s.id === "string") out.push(s.id);
      if (s && Array.isArray(s.then)) walkIds(s.then, out);
      if (s && Array.isArray(s.else)) walkIds(s.else, out);
    }
    return out;
  }

  function ids(spec: Spec): string[] {
    return walkIds(spec.steps, []);
  }

  function newStep(spec: Spec, type: string): Record<string, any> {
    const taken = ids(spec);
    let n = 1;
    while (taken.indexOf(`${type}_${n}`) >= 0) n++;
    const id = `${type}_${n}`;
    switch (type) {
      case "action":
        return { id, type, action: "", params: {} };
      case "condition":
        return { id, type, if: "", then: [], else: [] };
      case "wait":
        return { id, type, duration: "1h" };
      case "wait_for_event":
        return { id, type, event: "" };
      case "approval":
        return { id, type, approvers: { role: "admin" } };
      default:
        throw new Error(`Unknown step type "${type}"`);
    }
  }

  /** The value at a dotted path ("steps.1.then.0"). */
  function at(root: unknown, path: string): any {
    let v: any = root;
    for (const k of path.split(".")) {
      if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
      v = v[k];
    }
    return v;
  }

  function get(spec: object, path: string): Record<string, any> | undefined {
    return at(spec, path);
  }

  function splitPath(path: string): { parent: string; index: number } {
    const i = path.lastIndexOf(".");
    return { parent: path.slice(0, i), index: Number(path.slice(i + 1)) };
  }

  function listAt(root: any, parent: string): Record<string, any>[] {
    let list = at(root, parent);
    if (list === undefined && /\.(then|else)$/.test(parent)) {
      const owner = at(root, parent.slice(0, parent.lastIndexOf(".")));
      if (owner && owner.type === "condition") list = owner[parent.slice(parent.lastIndexOf(".") + 1)] = [];
    }
    if (!Array.isArray(list)) throw new Error(`No step list at ${parent}`);
    return list;
  }

  function insert<S extends Spec>(spec: S, parent: string, index: number, step: Record<string, any>): S {
    const out = clone(spec);
    listAt(out, parent).splice(index, 0, clone(step));
    return out;
  }

  function remove<S extends Spec>(spec: S, path: string): S {
    const out = clone(spec);
    const { parent, index } = splitPath(path);
    listAt(out, parent).splice(index, 1);
    return out;
  }

  /** Moves the step at `from` to `index` of the list at `toParent` (index as seen before the move). */
  function move<S extends Spec>(spec: S, from: string, toParent: string, index: number): S | null {
    if (toParent === from || toParent.startsWith(from + ".")) return null;
    const out = clone(spec);
    const src = splitPath(from);
    const srcList = listAt(out, src.parent);
    const dest = listAt(out, toParent);
    const step = srcList[src.index];
    if (!step) return null;
    srcList.splice(src.index, 1);
    let i = index;
    if (srcList === dest && src.index < index) i--;
    dest.splice(Math.max(0, Math.min(i, dest.length)), 0, step);
    return out;
  }

  function flatten(spec: Spec): FlatStep[] {
    const out: FlatStep[] = [];
    const walk = (steps: Record<string, any>[], parent: string, depth: number, branch: "then" | "else" | null) => {
      (steps || []).forEach((step, i) => {
        const path = `${parent}.${i}`;
        out.push({ path, step, depth, branch });
        if (step && step.type === "condition") {
          walk(step.then, `${path}.then`, depth + 1, "then");
          walk(step.else, `${path}.else`, depth + 1, "else");
        }
      });
    };
    walk(spec.steps, "steps", 0, null);
    return out;
  }

  /** Where the step at `moving` may be dropped (for the keyboard "Move to" menu). */
  function positions(spec: Spec, moving: string): DropTarget[] {
    const out: DropTarget[] = [];
    const self = splitPath(moving);
    const walk = (steps: Record<string, any>[], parent: string, depth: number) => {
      const list = steps || [];
      for (let i = 0; i <= list.length; i++) {
        if (!(parent === self.parent && i === self.index)) out.push({ parent, index: i, depth });
        const step = list[i];
        const path = `${parent}.${i}`;
        if (i < list.length && step && step.type === "condition" && path !== moving) {
          walk(step.then, `${path}.then`, depth + 1);
          walk(step.else, `${path}.else`, depth + 1);
        }
      }
    };
    walk(spec.steps, "steps", 0);
    return out;
  }

  /** validateSpec issues grouped by the step path they belong to ("" for the spec itself). */
  function issuesByStep(issues: { path: string; message: string; fix: string }[]): Record<string, StepIssue[]> {
    const out: Record<string, StepIssue[]> = {};
    for (const i of issues) {
      const m = /^(steps\.\d+(?:\.(?:then|else)\.\d+)*)(?:\.(.*))?$/.exec(i.path);
      const key = m ? m[1] : "";
      const field = m ? m[2] || "" : i.path;
      (out[key] = out[key] || []).push({ field, message: i.message, fix: i.fix });
    }
    return out;
  }

  function cleanStep(s: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (v === "" && k !== "if" && k !== "action" && k !== "event") continue;
      if (k === "else" && Array.isArray(v) && v.length === 0) continue;
      if (k === "match" && v && typeof v === "object" && Object.keys(v).length === 0) continue;
      out[k] = k === "then" || k === "else" ? (v || []).map(cleanStep) : v;
    }
    return out;
  }

  /** The spec to save: optional empties dropped. */
  function toSpec<S extends FullSpec>(spec: S): S {
    const out = { name: spec.name, trigger: clone(spec.trigger), steps: clone(spec.steps).map(cleanStep) } as S;
    if (spec.description) out.description = spec.description;
    if (spec.concurrency) out.concurrency = clone(spec.concurrency);
    if (out.trigger.type === "event" && out.trigger.match && Object.keys(out.trigger.match).length === 0) delete out.trigger.match;
    return out;
  }

  function resourceEvents(resources: string[]): string[] {
    const out: string[] = [];
    for (const r of resources) out.push(`${r}.created`, `${r}.updated`, `${r}.deleted`);
    return out;
  }

  return { ids, newStep, get, insert, remove, move, flatten, positions, issuesByStep, toSpec, resourceEvents };
}
