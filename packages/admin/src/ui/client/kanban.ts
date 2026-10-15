// Kanban logic: which column a card is in, moving it (drag or keyboard), the PATCH that
// persists a move, and the optimistic/rollback board states. Self-contained (see filters.ts).

export interface Board {
  /** The select field the board groups by. */
  field: string;
  /** Collection URL, e.g. /api/contacts. */
  path: string;
  /** Column keys in display order; "" is the "no value" column. */
  columns: string[];
  /** Card ids per column, in display order. */
  order: Record<string, string[]>;
}

export interface MovePlan {
  id: string;
  from: string;
  to: string;
  request: { method: "PATCH"; url: string; body: Record<string, unknown> };
  optimistic: Board;
  rollback: Board;
}

export type KanbanLib = ReturnType<typeof kanbanLib>;

export function kanbanLib() {
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  function board(field: string, path: string, columns: string[], values: Record<string, unknown>, ids: string[]): Board {
    const order: Record<string, string[]> = {};
    for (const c of columns) order[c] = [];
    const fallback = columns.indexOf("") >= 0 ? "" : columns[columns.length - 1];
    for (const id of ids) {
      const v = own(values, id) ? values[id] : null;
      const key = typeof v === "string" && own(order, v) ? v : fallback;
      order[key].push(id);
    }
    return { field, path, columns: columns.slice(), order };
  }

  function columnOf(b: Board, id: string): string | null {
    for (const c of b.columns) if (b.order[c].indexOf(id) >= 0) return c;
    return null;
  }

  function apply(b: Board, id: string, to: string, index?: number): Board {
    const order: Record<string, string[]> = {};
    for (const c of b.columns) order[c] = b.order[c].filter((x) => x !== id);
    const dest = order[to];
    const at = index === undefined || index < 0 || index > dest.length ? dest.length : index;
    dest.splice(at, 0, id);
    return { field: b.field, path: b.path, columns: b.columns, order };
  }

  function planMove(b: Board, id: string, to: string, index?: number): MovePlan | null {
    const from = columnOf(b, id);
    if (from === null || !own(b.order, to) || b.columns.indexOf(to) < 0) return null;
    if (from === to && index === undefined) return null;
    const body: Record<string, unknown> = {};
    body[b.field] = to === "" ? null : to;
    return {
      id,
      from,
      to,
      request: { method: "PATCH", url: `${b.path}/${encodeURIComponent(id)}`, body },
      optimistic: apply(b, id, to, index),
      rollback: b,
    };
  }

  /** The board to show once the PATCH finished. */
  function settle(plan: MovePlan, ok: boolean): Board {
    return ok ? plan.optimistic : plan.rollback;
  }

  /** ArrowLeft / ArrowRight move a focused card to the neighbouring column. */
  function keyTarget(b: Board, id: string, key: string): string | null {
    const dir = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (!dir) return null;
    const from = columnOf(b, id);
    if (from === null) return null;
    const next = b.columns[b.columns.indexOf(from) + dir];
    return next === undefined ? null : next;
  }

  function announce(title: string, column: string, ok: boolean): string {
    return ok ? `Moved ${title} to ${column}.` : `Could not move ${title} to ${column}. It is back where it was.`;
  }

  return { board, columnOf, apply, planMove, settle, keyTarget, announce };
}
