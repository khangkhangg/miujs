// DOM glue for the admin UI. Self-contained like the pure modules: the server ships it as
// `(${adminApp})(libs)`. It only enhances server-rendered pages (forms work without it) and
// builds DOM with createElement/textContent; it never assigns innerHTML.

import type { ExprLib } from "./expr.ts";
import type { FilterLib } from "./filters.ts";
import type { ImporterLib } from "./importer.ts";
import type { KanbanLib } from "./kanban.ts";
import type { SchemaFormLib } from "./schema-form.ts";
import type { WorkflowLib } from "./workflow.ts";

export interface ClientLibs {
  filters: FilterLib;
  kanban: KanbanLib;
  expr: ExprLib;
  workflow: WorkflowLib;
  schemaForm: SchemaFormLib;
  importer: ImporterLib;
}

export function adminApp(L: ClientLibs) {
  const doc = document;
  const $ = (sel: string, root: ParentNode = doc) => root.querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string, root: ParentNode = doc) => Array.prototype.slice.call(root.querySelectorAll(sel)) as HTMLElement[];
  const json = (s: string | undefined | null, fallback: any) => {
    try {
      return s ? JSON.parse(s) : fallback;
    } catch {
      return fallback;
    }
  };

  /** createElement with attributes (never on* handlers) and text/element children. */
  function h(tag: string, attrs?: Record<string, any> | null, ...kids: any[]): HTMLElement {
    const el = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false || /^on/i.test(k)) continue;
        if (k === "value") (el as HTMLInputElement).value = String(v);
        else if (k === "checked" || k === "selected" || k === "disabled" || k === "hidden") (el as any)[k] = !!v;
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(typeof kid === "string" || typeof kid === "number" ? doc.createTextNode(String(kid)) : kid);
    }
    return el;
  }

  const org = doc.body.getAttribute("data-org") || "";
  function api(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (org) headers["x-org-id"] = org;
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(url, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) }).then((res) =>
      res.text().then((t) => ({ ok: res.ok, status: res.status, data: json(t, null) })),
    );
  }

  const live = $("[data-live]");
  const say = (msg: string) => {
    if (live) live.textContent = msg;
  };
  const errorText = (data: any) => (data && data.error ? [data.error.message, data.error.fix].filter(Boolean).join(" ") : "The request failed.");

  // ---------------------------------------------------------------- confirmations
  for (const btn of $$("[data-confirm]")) {
    btn.addEventListener("click", (e) => {
      if (!window.confirm(btn.getAttribute("data-confirm") || "Are you sure?")) {
        e.preventDefault();
        return;
      }
      const form = (btn as HTMLButtonElement).form;
      if (form && !form.querySelector("input[name=confirmed]")) form.appendChild(h("input", { type: "hidden", name: "confirmed", value: "1" }));
    });
  }

  // ---------------------------------------------------------------- org switcher
  for (const sel of $$("select[data-autosubmit]")) {
    sel.addEventListener("change", () => {
      const form = (sel as HTMLSelectElement).form;
      if (form) form.submit();
    });
    const btn = sel.parentElement && $("button", sel.parentElement);
    if (btn) btn.classList.add("sr-only");
  }

  // ---------------------------------------------------------------- bulk selection
  for (const all of $$("[data-select-all]")) {
    const form = (all as HTMLInputElement).form!;
    const boxes = () => $$("input[name=ids]", form) as HTMLInputElement[];
    const count = $("[data-selected-count]", form);
    const sync = () => {
      const n = boxes().filter((b) => b.checked).length;
      if (count) count.textContent = n ? `${n} selected` : "None selected";
      for (const b of $$("[data-bulk]", form)) (b as HTMLButtonElement).disabled = n === 0;
      (all as HTMLInputElement).checked = n > 0 && n === boxes().length;
      (all as HTMLInputElement).indeterminate = n > 0 && n < boxes().length;
    };
    all.addEventListener("change", () => {
      for (const b of boxes()) b.checked = (all as HTMLInputElement).checked;
      sync();
    });
    form.addEventListener("change", sync);
    sync();
  }

  // ---------------------------------------------------------------- filter builder
  for (const form of $$("form[data-filter-builder]")) {
    const fields = json(form.getAttribute("data-fields"), []);
    const rowsBox = $("[data-filter-rows]", form)!;
    const hidden = $("input[name=filter]", form) as HTMLInputElement;
    const errBox = $("[data-filter-errors]", form)!;
    const fieldOf = (n: string) => fields.find((f: any) => f.name === n);
    const valueControl = (row: HTMLElement, f: any, op: string, value: string) => {
      const vi = L.filters.valueInput(f, op);
      const label = `Value for ${f.label}`;
      let el: HTMLElement;
      if (vi.kind === "boolean") el = h("select", { "aria-label": label, "data-v": "" }, h("option", { value: "true", selected: value === "true" }, op === "isNull" ? "yes" : "true"), h("option", { value: "false", selected: value === "false" }, op === "isNull" ? "no" : "false"));
      else if (vi.kind === "select") el = h("select", { "aria-label": label, "data-v": "" }, (vi.options || []).map((o: any) => h("option", { value: o.value, selected: o.value === value }, o.label)));
      else el = h("input", { type: vi.kind, step: vi.step, "aria-label": label, placeholder: vi.hint || "", value, "data-v": "" });
      const old = $("[data-v]", row);
      if (old) old.replaceWith(el);
      else row.insertBefore(el, $("[data-remove]", row));
    };
    const addRow = (r: { field: string; op: string; value: string }) => {
      const f = fieldOf(r.field) || fields[0];
      if (!f) return;
      const fieldSel = h("select", { "aria-label": "Field", "data-f": "" }, fields.map((x: any) => h("option", { value: x.name, selected: x.name === f.name }, x.label)));
      const opSel = h("select", { "aria-label": "Operator", "data-o": "" });
      const fillOps = (ff: any, cur: string) => {
        while (opSel.firstChild) opSel.removeChild(opSel.firstChild);
        for (const o of L.filters.operators(ff)) opSel.appendChild(h("option", { value: o.op, selected: o.op === cur }, o.label));
      };
      const row = h("div", { class: "filter-row" }, fieldSel, opSel, h("button", { type: "button", "data-remove": "", "aria-label": `Remove filter on ${f.label}` }, "Remove"));
      fillOps(f, r.op);
      valueControl(row, f, (opSel as HTMLSelectElement).value, r.value);
      fieldSel.addEventListener("change", () => {
        const nf = fieldOf((fieldSel as HTMLSelectElement).value);
        fillOps(nf, "");
        valueControl(row, nf, (opSel as HTMLSelectElement).value, "");
      });
      opSel.addEventListener("change", () => valueControl(row, fieldOf((fieldSel as HTMLSelectElement).value), (opSel as HTMLSelectElement).value, ""));
      $("[data-remove]", row)!.addEventListener("click", () => {
        row.remove();
        const first = $("select", rowsBox);
        if (first) first.focus();
      });
      rowsBox.appendChild(row);
      return row;
    };
    const initial = L.filters.filterToRows(json(hidden.value, {}), fields);
    while (rowsBox.firstChild) rowsBox.removeChild(rowsBox.firstChild);
    initial.forEach(addRow);
    const add = $("[data-filter-add]", form);
    if (add) {
      add.hidden = false;
      add.addEventListener("click", () => {
        const row = addRow({ field: fields[0] ? fields[0].name : "", op: "", value: "" });
        if (row) (row.firstChild as HTMLElement).focus();
      });
    }
    form.addEventListener("submit", (e) => {
      const rows = $$(".filter-row", rowsBox).map((row) => ({
        field: ($("[data-f]", row) as HTMLSelectElement).value,
        op: ($("[data-o]", row) as HTMLSelectElement).value,
        value: ($("[data-v]", row) as HTMLInputElement).value,
      }));
      const out = L.filters.rowsToFilter(rows, fields);
      while (errBox.firstChild) errBox.removeChild(errBox.firstChild);
      if (out.errors.length) {
        e.preventDefault();
        errBox.appendChild(h("ul", null, out.errors.map((x) => h("li", null, x.message))));
        errBox.hidden = false;
        errBox.focus();
        return;
      }
      hidden.value = Object.keys(out.filter).length ? JSON.stringify(out.filter) : "";
      if (!hidden.value) hidden.disabled = true;
      for (const el of $$("[name=cursor]", form)) (el as HTMLInputElement).disabled = true;
    });
  }

  // ---------------------------------------------------------------- kanban
  for (const boardEl of $$("[data-board]")) {
    const field = boardEl.getAttribute("data-field")!;
    const path = boardEl.getAttribute("data-path")!;
    const cols = $$("[data-col]", boardEl);
    const keys = cols.map((c) => c.getAttribute("data-col")!);
    const labelOf = (k: string) => (cols[keys.indexOf(k)] && cols[keys.indexOf(k)].getAttribute("data-label")) || k;
    const read = () => {
      const values: Record<string, string> = {};
      const ids: string[] = [];
      for (const c of cols) for (const card of $$("[data-id]", c)) {
        values[card.getAttribute("data-id")!] = c.getAttribute("data-col")!;
        ids.push(card.getAttribute("data-id")!);
      }
      return L.kanban.board(field, path, keys, values, ids);
    };
    const render = (b: any) => {
      for (const c of cols) {
        const key = c.getAttribute("data-col")!;
        for (const id of b.order[key]) {
          const card = $$("[data-id]", boardEl).find((x) => x.getAttribute("data-id") === id);
          if (card) c.appendChild(card);
        }
        const count = boardEl.querySelector(`[data-count="${CSS.escape(key)}"]`);
        if (count) count.textContent = String(b.order[key].length);
      }
    };
    const move = (card: HTMLElement, to: string) => {
      const id = card.getAttribute("data-id")!;
      const plan = L.kanban.planMove(read(), id, to);
      if (!plan) return;
      const title = card.getAttribute("data-title") || id;
      render(plan.optimistic);
      card.classList.add("pending");
      card.setAttribute("aria-busy", "true");
      card.focus();
      api(plan.request.method, plan.request.url, plan.request.body)
        .then((r) => r, () => ({ ok: false, status: 0, data: null }))
        .then((r) => {
          render(L.kanban.settle(plan, r.ok));
          card.classList.remove("pending");
          card.removeAttribute("aria-busy");
          card.focus();
          say(L.kanban.announce(title, labelOf(to), r.ok) + (r.ok ? "" : " " + errorText(r.data)));
        });
    };
    let dragging: HTMLElement | null = null;
    for (const card of $$("[data-id]", boardEl)) {
      card.addEventListener("dragstart", (e) => {
        dragging = card;
        card.setAttribute("aria-grabbed", "true");
        if ((e as DragEvent).dataTransfer) (e as DragEvent).dataTransfer!.setData("text/plain", card.getAttribute("data-id")!);
      });
      card.addEventListener("dragend", () => {
        card.removeAttribute("aria-grabbed");
        dragging = null;
      });
      card.addEventListener("keydown", (e) => {
        const ke = e as KeyboardEvent;
        if (ke.target !== card) return;
        const to = L.kanban.keyTarget(read(), card.getAttribute("data-id")!, ke.key);
        if (to !== null) {
          ke.preventDefault();
          move(card, to);
        } else if (ke.key === "ArrowDown" || ke.key === "ArrowUp") {
          const sib = (ke.key === "ArrowDown" ? card.nextElementSibling : card.previousElementSibling) as HTMLElement | null;
          if (sib) {
            ke.preventDefault();
            sib.focus();
          }
        }
      });
    }
    for (const c of cols) {
      const col = c.closest(".column") as HTMLElement;
      c.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("drop-target");
      });
      c.addEventListener("dragleave", () => col.classList.remove("drop-target"));
      c.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("drop-target");
        if (dragging) move(dragging, c.getAttribute("data-col")!);
      });
    }
  }

  // ---------------------------------------------------------------- rich text
  for (const box of $$("[data-richtext]")) {
    const ta = $("textarea", box) as HTMLTextAreaElement;
    const ed = $(".rte-editor", box)!;
    const bar = $(".rte-toolbar", box)!;
    ed.hidden = false;
    bar.hidden = false;
    ta.hidden = true;
    const label = doc.querySelector(`label[for="${CSS.escape(ta.id)}"]`) as HTMLLabelElement | null;
    if (label) label.addEventListener("click", () => ed.focus());
    for (const b of $$("button[data-cmd]", bar)) {
      b.addEventListener("click", () => {
        const [cmd, arg] = b.getAttribute("data-cmd")!.split(":");
        ed.focus();
        if (cmd === "createLink") {
          const url = window.prompt("Link address (https://…, mailto:…)");
          if (!url || !/^(https?:|mailto:|tel:|\/(?!\/))/i.test(url.trim())) return;
          doc.execCommand("createLink", false, url.trim());
        } else doc.execCommand(cmd, false, arg ? `<${arg}>` : undefined);
      });
    }
    // Pasted content goes in as plain text; the server sanitizes whatever is saved anyway.
    ed.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e as ClipboardEvent).clipboardData ? (e as ClipboardEvent).clipboardData!.getData("text/plain") : "";
      doc.execCommand("insertText", false, text);
    });
    const form = ta.form;
    if (form) form.addEventListener("submit", () => (ta.value = ed.innerHTML));
  }

  // ---------------------------------------------------------------- relation picker
  let pickers = 0;
  for (const box of $$("[data-relation]")) {
    const input = $("input", box) as HTMLInputElement;
    const current = $(".picker-current", box)!;
    const path = box.getAttribute("data-relation")!;
    const titleField = box.getAttribute("data-title-field") || "id";
    const n = ++pickers;
    const listId = `picker-list-${n}`;
    const search = h("input", { type: "search", id: `picker-${n}`, role: "combobox", "aria-expanded": "false", "aria-controls": listId, "aria-autocomplete": "list", autocomplete: "off", placeholder: "Search…" }) as HTMLInputElement;
    const list = h("ul", { id: listId, role: "listbox", hidden: true });
    const label = doc.querySelector(`label[for="${CSS.escape(input.id)}"]`) as HTMLLabelElement | null;
    if (label) label.htmlFor = search.id;
    input.type = "hidden";
    box.insertBefore(search, input);
    box.appendChild(list);
    const clear = h("button", { type: "button", class: "btn" }, "Clear");
    clear.addEventListener("click", () => {
      input.value = "";
      current.textContent = "";
      search.focus();
    });
    box.appendChild(clear);
    let items: { id: string; title: string }[] = [];
    let active = -1;
    let timer: any = 0;
    const close = () => {
      list.hidden = true;
      search.setAttribute("aria-expanded", "false");
      search.removeAttribute("aria-activedescendant");
    };
    const choose = (i: number) => {
      const it = items[i];
      if (!it) return;
      input.value = it.id;
      current.textContent = it.title;
      search.value = "";
      close();
    };
    const paint = () => {
      while (list.firstChild) list.removeChild(list.firstChild);
      items.forEach((it, i) => {
        const li = h("li", { role: "option", id: `${listId}-${i}`, "aria-selected": i === active ? "true" : "false" }, it.title, " ", h("span", { class: "muted" }, it.id));
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(i);
        });
        list.appendChild(li);
      });
      if (!items.length) list.appendChild(h("li", { class: "muted" }, "No matches"));
      list.hidden = false;
      search.setAttribute("aria-expanded", "true");
      if (active >= 0) search.setAttribute("aria-activedescendant", `${listId}-${active}`);
    };
    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (!q) return close();
      timer = setTimeout(() => {
        const qs = new URLSearchParams({ q, limit: "10", fields: titleField });
        api("GET", `${path}?${qs}`).then((r) => {
          items = r.ok && r.data && Array.isArray(r.data.items) ? r.data.items.map((x: any) => ({ id: String(x.id), title: String(x[titleField] ?? x.id) })) : [];
          active = items.length ? 0 : -1;
          paint();
        });
      }, 250);
    });
    search.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (list.hidden) return;
      if (ke.key === "ArrowDown" || ke.key === "ArrowUp") {
        ke.preventDefault();
        active = Math.max(0, Math.min(items.length - 1, active + (ke.key === "ArrowDown" ? 1 : -1)));
        paint();
      } else if (ke.key === "Enter") {
        ke.preventDefault();
        choose(active);
      } else if (ke.key === "Escape") close();
    });
    search.addEventListener("blur", () => setTimeout(close, 150));
  }

  // ---------------------------------------------------------------- import wizard
  for (const box of $$("[data-import]")) {
    const fields = json(box.getAttribute("data-fields"), []);
    const url = box.getAttribute("data-url")!;
    const listUrl = box.getAttribute("data-list-url")!;
    const file = $("input[type=file]", box) as HTMLInputElement;
    const mapBox = $("[data-step=map]", box)!;
    const reportBox = $("[data-step=report]", box)!;
    let csv = "";
    let mapping: Record<string, string | null> = {};
    const targets = L.importer.targets(fields);
    const showReport = (rep: any, extraRows?: any[]) => {
      while (reportBox.firstChild) reportBox.removeChild(reportBox.firstChild);
      const s = L.importer.summary(rep);
      const rows = extraRows || s.rows;
      reportBox.appendChild(h("h2", { tabindex: "-1" }, rep.dryRun ? "3. Dry-run report" : "Done"));
      reportBox.appendChild(h("p", { role: "status" }, s.title));
      if (rows.length) {
        reportBox.appendChild(
          h("div", { class: "table-wrap" }, h("table", null, h("caption", { class: "sr-only" }, "Rows with errors"), h("thead", null, h("tr", null, h("th", { scope: "col" }, "Row"), h("th", { scope: "col" }, "Problems"))), h("tbody", null, rows.map((r: any) => h("tr", null, h("td", null, String(r.row)), h("td", null, r.text)))))),
        );
      }
      if (s.canCommit) {
        const go = h("button", { type: "button", class: "primary" }, `4. Import ${rep.total} rows`);
        go.addEventListener("click", () => run(false));
        reportBox.appendChild(go);
      }
      if (!rep.dryRun) reportBox.appendChild(h("p", null, h("a", { href: listUrl }, "Back to the list")));
      reportBox.hidden = false;
      ($("h2", reportBox) as HTMLElement).focus();
    };
    const run = (dryRun: boolean) => {
      const dup = L.importer.duplicates(mapping);
      if (dup.length) return say(`Each field can be mapped once: ${dup.join(", ")}.`);
      say(dryRun ? "Checking…" : "Importing…");
      api("POST", url, L.importer.body(csv, mapping, dryRun)).then((r) => {
        if (r.ok) return showReport(r.data);
        const rowsErr = r.data && r.data.error && r.data.error.details && r.data.error.details.rows;
        if (rowsErr) return showReport({ dryRun: true, total: 0, valid: 0, invalid: rowsErr.length, columns: {}, ignored: [], errors: rowsErr });
        say(errorText(r.data));
      });
    };
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      f.text().then((text) => {
        csv = text;
        const hs = L.importer.headers(text);
        mapping = L.importer.guess(hs, fields);
        while (mapBox.firstChild) mapBox.removeChild(mapBox.firstChild);
        mapBox.appendChild(h("h2", null, "2. Map columns to fields"));
        const tbody = h("tbody");
        hs.forEach((hd, i) => {
          const sel = h("select", { id: `map-${i}`, "aria-label": `Field for column ${hd}` }, h("option", { value: "" }, "Skip this column"), targets.map((t: any) => h("option", { value: t.name, selected: mapping[hd] === t.name }, t.label)));
          sel.addEventListener("change", () => (mapping[hd] = (sel as HTMLSelectElement).value || null));
          tbody.appendChild(h("tr", null, h("th", { scope: "row" }, h("label", { for: `map-${i}` }, hd || `(column ${i + 1})`)), h("td", null, sel)));
        });
        mapBox.appendChild(h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, h("th", { scope: "col" }, "CSV column"), h("th", { scope: "col" }, "Field"))), tbody)));
        const check = h("button", { type: "button", class: "primary" }, "3. Check (dry run)");
        check.addEventListener("click", () => run(true));
        mapBox.appendChild(check);
        mapBox.hidden = false;
        reportBox.hidden = true;
      });
    });
  }

  // ---------------------------------------------------------------- workflow builder
  const wfBox = $("[data-workflow-builder]");
  if (wfBox) workflowBuilder(wfBox);

  function workflowBuilder(box: HTMLElement) {
    const W = L.workflow;
    const actions: any[] = json(box.getAttribute("data-actions"), []);
    const events: string[] = json(box.getAttribute("data-events"), []);
    const fieldsByResource: Record<string, string[]> = json(box.getAttribute("data-fields"), {});
    const saveUrl = box.getAttribute("data-save-url")!;
    const validateUrl = box.getAttribute("data-validate-url")!;
    const publishUrl = box.getAttribute("data-publish-url")!;
    const editUrl = box.getAttribute("data-edit-url")!;
    const canEdit = box.getAttribute("data-can-edit") === "true";
    let spec: any = json(box.getAttribute("data-spec"), { name: "", trigger: { type: "manual" }, steps: [] });
    let issues: Record<string, any[]> = {};
    const rawMode: Record<string, boolean> = {};
    let dragFrom: string | null = null;
    const root = $("[data-builder-root]", box)!;
    const status = $("[data-builder-status]", box)!;

    const set = (next: any, focusKey?: string) => {
      spec = next;
      render(focusKey);
    };
    const mutate = (path: string, fn: (step: any) => void) => {
      const next = JSON.parse(JSON.stringify(spec));
      fn(W.get(next, path));
      spec = next;
    };
    const paths = () => {
      const out = ["data.id", "data.orgId", "data.changes", "data.before"];
      const tr = spec.trigger || {};
      const res = tr.type === "event" && typeof tr.event === "string" ? tr.event.split(".")[0] : "";
      for (const f of fieldsByResource[res] || []) out.push(`data.record.${f}`);
      for (const id of W.ids(spec)) out.push(`steps.${id}.output`);
      return out;
    };
    const issueList = (key: string) => {
      const list = issues[key];
      if (!list || !list.length) return null;
      return h("ul", { class: "field-error", role: "alert" }, list.map((i: any) => h("li", null, `${i.field ? i.field + ": " : ""}${i.message}. ${i.fix}`)));
    };
    const labelled = (label: string, control: HTMLElement, id: string) => {
      control.id = id;
      return h("div", { class: "field" }, h("label", { for: id }, label), control);
    };
    const text = (path: string, key: string, label: string, value: string, onChange: (v: string) => void, attrs: Record<string, any> = {}) => {
      const el = h("input", Object.assign({ type: "text", value: value ?? "", "data-focus": `${path}:${key}` }, attrs)) as HTMLInputElement;
      el.addEventListener("change", () => onChange(el.value));
      return labelled(label, el, `wf-${path}-${key}`.replace(/\./g, "-"));
    };

    function triggerEditor() {
      const tr = spec.trigger || { type: "manual" };
      const typeSel = h("select", { "data-focus": "trigger:type" }, ["event", "cron", "manual"].map((t) => h("option", { value: t, selected: tr.type === t }, t === "event" ? "When a record changes (event)" : t === "cron" ? "On a schedule (cron)" : "Manually")));
      typeSel.addEventListener("change", () => {
        const t = (typeSel as HTMLSelectElement).value;
        set(Object.assign({}, spec, { trigger: t === "event" ? { type: "event", event: events[0] || "" } : t === "cron" ? { type: "cron", cron: "0 9 * * 1" } : { type: "manual" } }), "trigger:type");
      });
      const parts: HTMLElement[] = [labelled("Trigger", typeSel, "wf-trigger-type")];
      if (tr.type === "event") {
        const listId = "wf-events";
        const ev = h("input", { type: "text", list: listId, value: tr.event || "", "data-focus": "trigger:event" }) as HTMLInputElement;
        ev.addEventListener("change", () => set(Object.assign({}, spec, { trigger: Object.assign({}, tr, { event: ev.value.trim() }) }), "trigger:event"));
        parts.push(labelled("Event", ev, "wf-trigger-event"), h("datalist", { id: listId }, events.map((e) => h("option", { value: e }))));
      } else if (tr.type === "cron") {
        const c = h("input", { type: "text", value: tr.cron || "", "data-focus": "trigger:cron" }) as HTMLInputElement;
        c.addEventListener("change", () => set(Object.assign({}, spec, { trigger: Object.assign({}, tr, { cron: c.value.trim() }) }), "trigger:cron"));
        parts.push(labelled("Cron (5 fields, UTC)", c, "wf-trigger-cron"));
      }
      return h("section", { class: "panel", "aria-labelledby": "wf-trigger-h" }, h("h2", { id: "wf-trigger-h" }, "Trigger"), parts, issueList(""));
    }

    function paramsEditor(path: string, step: any) {
      const def = actions.find((a) => a.name === step.action);
      if (!def) return null;
      const fields = L.schemaForm.fields(def.params);
      const values = L.schemaForm.toForm(fields, step.params || {});
      const errs: HTMLElement[] = [];
      const update = () => {
        const raw: Record<string, string> = {};
        for (const f of fields) {
          const el = box.querySelector(`[data-param="${CSS.escape(path + ":" + f.name)}"]`) as HTMLInputElement | null;
          if (el) raw[f.name] = el.type === "checkbox" ? (el.checked ? "true" : "") : el.value;
        }
        const out = L.schemaForm.coerce(fields, raw);
        mutate(path, (s) => (s.params = out.value));
        say(out.errors.length ? out.errors.map((e) => `${e.name} ${e.message}`).join("; ") : "");
      };
      const rows = fields.map((f) => {
        const id = `wf-${path}-p-${f.name}`.replace(/\./g, "-");
        const common = { id, "data-param": `${path}:${f.name}`, "data-focus": `${path}:p:${f.name}` };
        let el: HTMLElement;
        if (f.kind === "enum") el = h("select", common, h("option", { value: "" }, "—"), (f.options || []).map((o) => h("option", { value: o, selected: values[f.name] === o }, o)));
        else if (f.kind === "boolean") el = h("input", Object.assign({ type: "checkbox", checked: values[f.name] === "true" }, common));
        else if (f.kind === "json") el = h("textarea", Object.assign({ rows: 3, class: "mono", value: values[f.name] || "" }, common));
        else el = h("input", Object.assign({ type: "text", value: values[f.name] || "", placeholder: f.kind === "text" ? "text or {{ data.field }}" : f.kind }, common));
        el.addEventListener("change", update);
        return h("div", { class: "field" }, h("label", { for: id }, f.name, f.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : null), el, f.description ? h("p", { class: "help" }, f.description) : null);
      });
      return h("fieldset", { class: "panel" }, h("legend", null, "Parameters"), def.description ? h("p", { class: "help" }, def.description) : null, rows, errs);
    }

    function conditionEditor(path: string, step: any) {
      const parsed = L.expr.parse(step.if || "");
      const raw = rawMode[path] || parsed === null;
      const wrap = h("div", { class: "panel" });
      const toggle = h("button", { type: "button", "aria-pressed": raw ? "true" : "false" }, raw ? "Use the builder" : "Edit as text");
      toggle.addEventListener("click", () => {
        if (raw && L.expr.parse(step.if || "") === null) return say("This expression is too complex for the builder; keep editing it as text.");
        rawMode[path] = !raw;
        render(`${path}:if`);
      });
      wrap.appendChild(h("div", { class: "toolbar" }, h("strong", null, "If"), toggle));
      if (raw) {
        const ta = h("textarea", { rows: 2, class: "mono", value: step.if || "", "data-focus": `${path}:if`, "aria-describedby": `wf-${path}-if-help`.replace(/\./g, "-") }) as HTMLTextAreaElement;
        ta.addEventListener("change", () => mutate(path, (s) => (s.if = ta.value.trim())));
        wrap.appendChild(labelled("Expression", ta, `wf-${path}-if`.replace(/\./g, "-")));
        wrap.appendChild(h("p", { class: "help", id: `wf-${path}-if-help`.replace(/\./g, "-") }, "Paths start with data., input. or steps.<id>.output; operators == != > >= < <= in && || !. Checked on the server when you validate or save."));
        return wrap;
      }
      const state = parsed || { join: "&&", rows: [] };
      const listId = `wf-paths-${path}`.replace(/\./g, "-");
      wrap.appendChild(h("datalist", { id: listId }, paths().map((p) => h("option", { value: p }))));
      const write = (rows: any[], join: string) => {
        try {
          const src = L.expr.build(rows, join as "&&" | "||");
          mutate(path, (s) => (s.if = src));
          say("");
        } catch (err) {
          say(String((err as Error).message));
        }
      };
      const joinSel = h("select", { "aria-label": "Match", "data-focus": `${path}:join` }, h("option", { value: "&&", selected: state.join === "&&" }, "All of these"), h("option", { value: "||", selected: state.join === "||" }, "Any of these"));
      joinSel.addEventListener("change", () => write(state.rows, (joinSel as HTMLSelectElement).value));
      wrap.appendChild(joinSel);
      const OPS: [string, string][] = [["==", "is"], ["!=", "is not"], [">", ">"], [">=", "≥"], ["<", "<"], ["<=", "≤"], ["in", "is one of"], ["contains", "contains"], ["empty", "is empty"], ["notEmpty", "is not empty"], ["changed", "changed"]];
      state.rows.forEach((r: any, i: number) => {
        const key = `${path}:c${i}`;
        const left = h("input", { type: "text", list: listId, value: r.left, "aria-label": `Condition ${i + 1} path`, "data-focus": `${key}:l` }) as HTMLInputElement;
        const op = h("select", { "aria-label": `Condition ${i + 1} operator`, "data-focus": `${key}:o` }, OPS.map(([v, l]) => h("option", { value: v, selected: r.op === v }, l))) as HTMLSelectElement;
        const kind = h("select", { "aria-label": `Condition ${i + 1} value type`, "data-focus": `${key}:k` }, ["text", "number", "boolean"].map((k) => h("option", { value: k, selected: (r.kind || "text") === k }, k))) as HTMLSelectElement;
        const val = h("input", { type: "text", value: r.value, "aria-label": `Condition ${i + 1} value`, "data-focus": `${key}:v` }) as HTMLInputElement;
        const del = h("button", { type: "button", "aria-label": `Remove condition ${i + 1}` }, "Remove");
        const sync = () => {
          state.rows[i] = { left: left.value.trim(), op: op.value, value: val.value, kind: kind.value as "text" | "number" | "boolean" };
          write(state.rows, (joinSel as HTMLSelectElement).value);
        };
        for (const el of [left, op, kind, val]) el.addEventListener("change", sync);
        del.addEventListener("click", () => {
          state.rows.splice(i, 1);
          write(state.rows, (joinSel as HTMLSelectElement).value);
          render(`${path}:add-cond`);
        });
        wrap.appendChild(h("div", { class: "filter-row" }, left, op, kind, val, del));
      });
      const add = h("button", { type: "button", "data-focus": `${path}:add-cond` }, "Add condition");
      add.addEventListener("click", () => {
        state.rows.push({ left: paths().find((p) => p.indexOf("data.record.") === 0) || "data.id", op: "==", value: "", kind: "text" });
        write(state.rows, (joinSel as HTMLSelectElement).value);
        render(`${path}:c${state.rows.length - 1}:l`);
      });
      wrap.appendChild(add);
      return wrap;
    }

    function stepBody(path: string, step: any) {
      switch (step.type) {
        case "action": {
          const sel = h("select", { "data-focus": `${path}:action` }, h("option", { value: "" }, "Choose an action…"), actions.map((a) => h("option", { value: a.name, selected: a.name === step.action }, a.name)));
          sel.addEventListener("change", () => {
            mutate(path, (s) => {
              s.action = (sel as HTMLSelectElement).value;
              s.params = {};
            });
            render(`${path}:action`);
          });
          return [labelled("Action", sel, `wf-${path}-action`.replace(/\./g, "-")), paramsEditor(path, step)];
        }
        case "condition":
          return [conditionEditor(path, step)];
        case "wait":
          return [text(path, "duration", "Wait for (e.g. 30m, 12h, 2d)", String(step.duration ?? ""), (v) => mutate(path, (s) => (s.duration = v.trim())))];
        case "wait_for_event":
          return [
            text(path, "event", "Event name", step.event || "", (v) => mutate(path, (s) => (s.event = v.trim())), { list: "wf-events" }),
            text(path, "timeout", "Give up after (optional, e.g. 7d)", String(step.timeout ?? ""), (v) => mutate(path, (s) => (v.trim() ? (s.timeout = v.trim()) : delete s.timeout))),
          ];
        case "approval": {
          const a = step.approvers || {};
          return [
            text(path, "role", "Approver role(s), comma-separated", Array.isArray(a.role) ? a.role.join(", ") : a.role || "", (v) =>
              mutate(path, (s) => {
                const list = v.split(",").map((x) => x.trim()).filter(Boolean);
                s.approvers = Object.assign({}, s.approvers);
                if (list.length) s.approvers.role = list.length === 1 ? list[0] : list;
                else delete s.approvers.role;
              }),
            ),
            text(path, "users", "Approver user ids, comma-separated", (a.users || []).join(", "), (v) =>
              mutate(path, (s) => {
                const list = v.split(",").map((x) => x.trim()).filter(Boolean);
                s.approvers = Object.assign({}, s.approvers);
                if (list.length) s.approvers.users = list;
                else delete s.approvers.users;
              }),
            ),
            text(path, "timeout", "Give up after (optional, e.g. 3d)", String(step.timeout ?? ""), (v) => mutate(path, (s) => (v.trim() ? (s.timeout = v.trim()) : delete s.timeout))),
          ];
        }
      }
      return [];
    }

    const TYPE_LABEL: Record<string, string> = { action: "Action", condition: "Condition", wait: "Wait", wait_for_event: "Wait for event", approval: "Approval" };

    function dropZone(parent: string, index: number) {
      const z = h("li", { class: "drop", "aria-hidden": "true" });
      z.addEventListener("dragover", (e) => {
        e.preventDefault();
        z.classList.add("active");
      });
      z.addEventListener("dragleave", () => z.classList.remove("active"));
      z.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragFrom) return;
        const next = W.move(spec, dragFrom, parent, index);
        dragFrom = null;
        if (next) set(next);
      });
      return z;
    }

    function stepCard(path: string, step: any): HTMLElement {
      const n = W.flatten(spec).findIndex((x) => x.path === path) + 1;
      const head = h("header", null, h("h3", { id: `wf-h-${path}`.replace(/\./g, "-") }, `${n}. ${TYPE_LABEL[step.type] || step.type}`));
      const tools = h("div", { class: "toolbar" });
      if (canEdit) {
        const handle = h("button", { type: "button", draggable: "true", "aria-label": `Drag step ${step.id}` }, "⠿ Drag");
        handle.addEventListener("dragstart", (e) => {
          dragFrom = path;
          if ((e as DragEvent).dataTransfer) (e as DragEvent).dataTransfer!.setData("text/plain", path);
        });
        const { parent, index } = (() => {
          const i = path.lastIndexOf(".");
          return { parent: path.slice(0, i), index: Number(path.slice(i + 1)) };
        })();
        const up = h("button", { type: "button", "aria-label": `Move step ${step.id} up`, disabled: index === 0, "data-focus": `${path}:up` }, "↑");
        up.addEventListener("click", () => set(W.move(spec, path, parent, index - 1) || spec));
        const down = h("button", { type: "button", "aria-label": `Move step ${step.id} down`, "data-focus": `${path}:down` }, "↓");
        down.addEventListener("click", () => set(W.move(spec, path, parent, index + 2) || spec));
        const targets = W.positions(spec, path);
        const moveSel = h("select", { "aria-label": `Move step ${step.id} to` }, h("option", { value: "" }, "Move to…"), targets.map((t, i) => h("option", { value: String(i) }, `${"— ".repeat(t.depth)}${t.parent === "steps" ? "Top level" : t.parent.replace(/^steps\./, "inside ").replace(/\.(then|else)$/, " ($1)")}, position ${t.index + 1}`)));
        moveSel.addEventListener("change", () => {
          const t = targets[Number((moveSel as HTMLSelectElement).value)];
          if (t) set(W.move(spec, path, t.parent, t.index) || spec);
        });
        const del = h("button", { type: "button", class: "danger", "aria-label": `Delete step ${step.id}` }, "Delete");
        del.addEventListener("click", () => {
          if (window.confirm(`Delete step ${step.id}?`)) set(W.remove(spec, path));
        });
        tools.append(handle, up, down, moveSel, del);
      }
      head.appendChild(tools);
      const card = h(
        "li",
        { class: `step${issues[path] ? " has-error" : ""}`, "aria-labelledby": `wf-h-${path}`.replace(/\./g, "-"), "data-path": path },
        head,
        issueList(path),
        text(path, "id", "Step id", step.id, (v) => mutate(path, (s) => (s.id = v.trim()))),
        stepBody(path, step),
      );
      if (step.type === "condition") {
        for (const branch of ["then", "else"]) {
          card.appendChild(h("div", { class: "branch" }, h("h4", null, branch === "then" ? "Then" : "Otherwise"), stepList(step[branch] || [], `${path}.${branch}`)));
        }
      }
      return card;
    }

    function stepList(steps: any[], parent: string): HTMLElement {
      const ol = h("ol", { class: "steps" });
      steps.forEach((s, i) => {
        if (canEdit) ol.appendChild(dropZone(parent, i));
        ol.appendChild(stepCard(`${parent}.${i}`, s));
      });
      if (canEdit) {
        ol.appendChild(dropZone(parent, steps.length));
        const typeSel = h("select", { "aria-label": `Type of new step${parent === "steps" ? "" : " in this branch"}` }, Object.keys(TYPE_LABEL).map((t) => h("option", { value: t }, TYPE_LABEL[t])));
        const add = h("button", { type: "button", "data-focus": `${parent}:add` }, "Add step");
        add.addEventListener("click", () => {
          const st = W.newStep(spec, (typeSel as HTMLSelectElement).value);
          set(W.insert(spec, parent, steps.length, st), `${parent}.${steps.length}:id`);
        });
        ol.appendChild(h("li", { class: "toolbar" }, typeSel, add));
      }
      return ol;
    }

    function render(focusKey?: string) {
      const active = focusKey || (doc.activeElement && doc.activeElement.getAttribute("data-focus")) || null;
      while (root.firstChild) root.removeChild(root.firstChild);
      root.appendChild(
        h(
          "section",
          { class: "panel" },
          text("spec", "name", "Name (letters, digits, . _ -)", spec.name || "", (v) => (spec = Object.assign({}, spec, { name: v.trim() })), { readonly: box.getAttribute("data-existing") === "true" }),
          text("spec", "description", "Description", spec.description || "", (v) => (spec = Object.assign({}, spec, { description: v }))),
        ),
      );
      root.appendChild(triggerEditor());
      root.appendChild(h("h2", null, "Steps"));
      root.appendChild(stepList(spec.steps || [], "steps"));
      if (!canEdit) for (const el of $$("input,select,textarea,button", root)) (el as HTMLInputElement).disabled = true;
      if (active) {
        const el = root.querySelector(`[data-focus="${CSS.escape(active)}"]`) as HTMLElement | null;
        if (el) el.focus();
      }
    }

    const showIssues = (list: any[]) => {
      issues = W.issuesByStep(list || []);
      render();
      const n = (list || []).length;
      status.textContent = n ? `${n} problem${n === 1 ? "" : "s"} found. They are shown next to the steps.` : "No problems found.";
      const first = root.querySelector(".has-error, [role=alert]") as HTMLElement | null;
      if (first) first.scrollIntoView({ block: "center" });
    };
    const issuesOf = (r: any) => (r.data && r.data.error && r.data.error.details && r.data.error.details.issues) || (r.data && r.data.issues) || null;

    const btn = (sel: string, fn: () => void) => {
      const b = $(sel, box);
      if (b) b.addEventListener("click", fn);
    };
    btn("[data-validate]", () => {
      api("POST", validateUrl, { spec: W.toSpec(spec) }).then((r) => (r.ok ? showIssues(r.data.issues || []) : (status.textContent = errorText(r.data))));
    });
    const save = (publish: boolean) => {
      status.textContent = "Saving…";
      api("POST", saveUrl, { spec: W.toSpec(spec) }).then((r) => {
        const list = issuesOf(r);
        if (!r.ok) return list ? showIssues(list) : (status.textContent = errorText(r.data));
        issues = {};
        const saved = r.data;
        const done = (msg: string) => {
          status.textContent = msg;
          if (box.getAttribute("data-existing") !== "true") window.location.assign(editUrl.replace(":name", encodeURIComponent(saved.name)));
          else render();
        };
        if (!publish) return done(`Saved version ${saved.version} as a draft.`);
        api("POST", publishUrl.replace(":name", encodeURIComponent(saved.name)), { version: saved.version }).then((p) =>
          p.ok ? done(`Saved and published version ${saved.version}.`) : (status.textContent = errorText(p.data)),
        );
      });
    };
    btn("[data-save]", () => save(false));
    btn("[data-publish]", () => save(true));
    render();
  }
}
