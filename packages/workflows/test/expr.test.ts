import { describe, expect, test } from "bun:test";
import { compileExpression, evaluate, interpolate } from "../src/index.ts";

const scope = {
  data: { amount: 12000, stage: "won", tags: ["vip", "eu"], owner: { name: "Ann" }, zero: 0, nothing: null },
  input: { id: "c1" },
  steps: { enrich: { output: { score: 42 } } },
};

const ev = (src: string) => evaluate(src, scope);

describe("expressions: values", () => {
  test("literals", () => {
    expect(ev("1")).toBe(1);
    expect(ev("1.5")).toBe(1.5);
    expect(ev("'a'")).toBe("a");
    expect(ev('"b"')).toBe("b");
    expect(ev("true")).toBe(true);
    expect(ev("false")).toBe(false);
    expect(ev("null")).toBe(null);
    expect(ev("'it\\'s'")).toBe("it's");
  });

  test("dotted paths into data, input and steps", () => {
    expect(ev("data.amount")).toBe(12000);
    expect(ev("data.owner.name")).toBe("Ann");
    expect(ev("input.id")).toBe("c1");
    expect(ev("steps.enrich.output.score")).toBe(42);
    expect(ev("data.tags.1")).toBe("eu");
    expect(ev("data.missing.deeper")).toBe(undefined);
  });

  test("paths never reach prototypes", () => {
    expect(ev("data.constructor")).toBe(undefined);
    expect(ev("data.__proto__")).toBe(undefined);
    expect(ev("data.owner.hasOwnProperty")).toBe(undefined);
  });

  test("arrays expose indexes and length", () => {
    expect(ev("data.tags.length")).toBe(2);
    expect(ev("data.tags.0")).toBe("vip");
  });
});

describe("expressions: operators", () => {
  test("comparison", () => {
    expect(ev("data.amount > 10000")).toBe(true);
    expect(ev("data.amount >= 12000")).toBe(true);
    expect(ev("data.amount < 12000")).toBe(false);
    expect(ev("data.amount <= 11999")).toBe(false);
    expect(ev("data.stage == 'won'")).toBe(true);
    expect(ev("data.stage != 'won'")).toBe(false);
    expect(ev("data.nothing == null")).toBe(true);
  });

  test("logic, precedence and parentheses", () => {
    expect(ev("data.amount > 10000 && data.stage == 'won'")).toBe(true);
    expect(ev("data.amount > 99999 || data.stage == 'won'")).toBe(true);
    expect(ev("!(data.amount > 10000)")).toBe(false);
    expect(ev("!data.zero")).toBe(true);
    expect(ev("true || false && false")).toBe(true); // && binds tighter
    expect(ev("(true || false) && false")).toBe(false);
  });

  test("in: arrays, array literals and substrings", () => {
    expect(ev("'vip' in data.tags")).toBe(true);
    expect(ev("'us' in data.tags")).toBe(false);
    expect(ev("data.stage in ['won', 'lost']")).toBe(true);
    expect(ev("'An' in data.owner.name")).toBe(true);
    expect(ev("'x' in data.missing")).toBe(false);
  });

  test("ordering comparisons between different types are false", () => {
    expect(ev("data.stage > 5")).toBe(false);
    expect(ev("data.missing < 5")).toBe(false);
  });
});

describe("expressions: rejected input", () => {
  const bad: [string, string][] = [
    ["data.amount +", "Unexpected"],
    ["foo.bar", "Unknown name"],
    ["data.amount = 5", "Unexpected"],
    ["data.fn()", "Unexpected"],
    ["(data.amount", "Expected )"],
    ["'unterminated", "Unterminated"],
    ["data.amount > 1 extra", "Unexpected"],
    ["data['x']", "Unexpected"],
    ["", "empty"],
  ];
  for (const [src, msg] of bad) {
    test(JSON.stringify(src), () => {
      let err: any;
      try {
        compileExpression(src);
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("MIU_E_WORKFLOW_EXPRESSION");
      expect(err.message).toContain(msg);
      expect(err.fix).toBeTruthy();
    });
  }

  test("roots can be restricted", () => {
    expect(() => compileExpression("steps.x.output", { roots: ["data"] })).toThrow("Unknown name");
  });
});

describe("interpolate", () => {
  test("whole-string templates keep the value's type", () => {
    expect(interpolate("{{ data.amount }}", scope)).toBe(12000);
    expect(interpolate("{{data.tags}}", scope)).toEqual(["vip", "eu"]);
  });

  test("mixed templates become strings", () => {
    expect(interpolate("Hi {{ data.owner.name }}, deal {{ data.amount }}!", scope)).toBe("Hi Ann, deal 12000!");
    expect(interpolate("x={{ data.missing }}", scope)).toBe("x=");
  });

  test("objects and arrays are interpolated deeply; other values pass through", () => {
    expect(interpolate({ to: "{{ input.id }}", n: 3, list: ["{{ data.stage }}"] }, scope)).toEqual({ to: "c1", n: 3, list: ["won"] });
    expect(interpolate(true, scope)).toBe(true);
  });
});
