import { describe, expect, test } from "bun:test";
import { kanbanLib } from "../../src/ui/client/kanban.ts";

const lib = kanbanLib();
const board = () => lib.board("stage", "/api/contacts", ["lead", "customer", "lost", ""], { a: "lead", b: "lead", c: "customer" }, ["a", "b", "c"]);

describe("kanban: board state", () => {
  test("cards are grouped by column, in record order; unknown values go to the empty column", () => {
    const b = lib.board("stage", "/api/contacts", ["lead", "won", ""], { a: "lead", x: "weird", y: null }, ["a", "x", "y"]);
    expect(b.order).toEqual({ lead: ["a"], won: [], "": ["x", "y"] });
  });

  test("columnOf finds a card", () => {
    expect(lib.columnOf(board(), "c")).toBe("customer");
    expect(lib.columnOf(board(), "zzz")).toBeNull();
  });

  test("apply moves a card immutably, to the end or an index", () => {
    const b = board();
    const moved = lib.apply(b, "a", "customer");
    expect(moved.order).toEqual({ lead: ["b"], customer: ["c", "a"], lost: [], "": [] });
    expect(b.order.lead).toEqual(["a", "b"]);
    expect(lib.apply(b, "a", "customer", 0).order.customer).toEqual(["a", "c"]);
    expect(lib.apply(b, "b", "lead", 0).order.lead).toEqual(["b", "a"]);
  });
});

describe("kanban: move → PATCH with optimistic update and rollback", () => {
  test("planMove gives the PATCH request and both board states", () => {
    const b = board();
    const plan = lib.planMove(b, "a", "lost")!;
    expect(plan.request).toEqual({ method: "PATCH", url: "/api/contacts/a", body: { stage: "lost" } });
    expect(plan.from).toBe("lead");
    expect(plan.to).toBe("lost");
    expect(plan.optimistic.order.lost).toEqual(["a"]);
    expect(plan.rollback.order).toEqual(b.order);
  });

  test("moving to the empty column clears the field", () => {
    expect(lib.planMove(board(), "a", "")!.request.body).toEqual({ stage: null });
  });

  test("ids are URL-encoded in the request", () => {
    const b = lib.board("stage", "/api/contacts", ["lead", "lost"], { "a/../b?x": "lead" }, ["a/../b?x"]);
    expect(lib.planMove(b, "a/../b?x", "lost")!.request.url).toBe("/api/contacts/a%2F..%2Fb%3Fx");
  });

  test("no plan for a no-op move or an unknown card/column", () => {
    expect(lib.planMove(board(), "a", "lead")).toBeNull();
    expect(lib.planMove(board(), "zzz", "lost")).toBeNull();
    expect(lib.planMove(board(), "a", "nope")).toBeNull();
  });

  test("settle: success keeps the optimistic board, failure restores the original", () => {
    const plan = lib.planMove(board(), "a", "lost")!;
    expect(lib.settle(plan, true).order.lost).toEqual(["a"]);
    expect(lib.settle(plan, false).order.lead).toEqual(["a", "b"]);
  });
});

describe("kanban: keyboard", () => {
  test("arrow keys pick the neighbouring column; other keys do nothing", () => {
    const b = board();
    expect(lib.keyTarget(b, "a", "ArrowRight")).toBe("customer");
    expect(lib.keyTarget(b, "c", "ArrowLeft")).toBe("lead");
    expect(lib.keyTarget(b, "a", "ArrowLeft")).toBeNull();
    expect(lib.keyTarget(lib.apply(b, "a", ""), "a", "ArrowRight")).toBeNull();
    expect(lib.keyTarget(b, "a", "Enter")).toBeNull();
  });

  test("announce gives a screen-reader message", () => {
    expect(lib.announce("Ann", "Customer", true)).toBe("Moved Ann to Customer.");
    expect(lib.announce("Ann", "Customer", false)).toBe("Could not move Ann to Customer. It is back where it was.");
  });
});
