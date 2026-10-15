// @ts-check
/**
 * MiuJS tour editor (no build step, no dependencies). Two modes, chosen by the page data:
 *  - "tours":  list the creator's tours and create a new one.
 *  - "editor": manage one tour — upload/reorder/rename scenes, set the start scene and initial views, place
 *              hotspots by clicking the panorama (screen -> yaw/pitch via math.js), drag them to move, edit
 *              them in the side panel, and publish (validation problems are listed).
 * Every write goes through the creator JSON API with `X-Requested-With` (the kit's CSRF guard) and same-origin
 * cookies. `window.miuEditor` exposes the state and viewer for DevTools debugging.
 */
import { createViewer, pageData } from "./viewer.js";

/** @typedef {import("./viewer.js").Scene} Scene */
/** @typedef {import("./viewer.js").Hotspot} Hotspot */
/** @typedef {{ id: string, title: string, slug: string, description?: string, status: "draft" | "published", startSceneId?: string }} Tour */

const data = pageData() || {};
const base = /** @type {string} */ (data.base || "");
const app = /** @type {HTMLElement} */ (document.getElementById("miu-editor-app"));

/**
 * Tiny DOM builder: h("button", { class: "x", onclick: fn }, "text", child).
 * @param {string} tag @param {Record<string, any>} [props] @param {...(Node | string | null | undefined | false)} kids
 */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k in e && typeof v !== "string") /** @type {any} */ (e)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

class ApiError extends Error {
  /** @param {number} status @param {any} body */
  constructor(status, body) {
    super((body && (body.detail || body.title)) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** JSON call to the creator API. @param {string} method @param {string} path @param {unknown} [body] */
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", "x-requested-with": "miu-tour-editor", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = res.status === 204 ? "" : await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

const status = h("p", { class: "miu-status", role: "status", "aria-live": "polite" });
/** @param {string} text @param {boolean} [error] */
function say(text, error = false) {
  status.textContent = text;
  status.classList.toggle("is-error", error);
}
/** Run an async action, reporting failures in the status line. @param {() => Promise<unknown>} fn @param {string} [done] */
async function run(fn, done) {
  try {
    await fn();
    if (done) say(done);
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(err); // API errors are expected (validation) and shown inline
    say(err instanceof Error ? err.message : String(err), true);
  }
}

// ---------------------------------------------------------------- tours list

async function toursPage() {
  const list = h("ul", { class: "miu-tour-list" });
  const title = /** @type {HTMLInputElement} */ (h("input", { name: "title", required: true, maxLength: 120, placeholder: "e.g. Seaside villa", "aria-label": "New tour title" }));
  const form = h("form", { class: "miu-create", onsubmit: (/** @type {Event} */ e) => {
    e.preventDefault();
    void run(async () => {
      const tour = await api("POST", "/api/tours", { title: title.value });
      location.href = `${base}/editor/${tour.id}`;
    });
  } }, title, h("button", { type: "submit" }, "Create tour"));
  app.replaceChildren(h("div", { class: "miu-tours" }, h("h1", {}, "Your tours"), form, list, status));
  await run(async () => {
    const { items } = await api("GET", "/api/tours?limit=100");
    if (!items.length) list.append(h("li", { class: "miu-empty" }, "No tours yet — create one above."));
    for (const t of /** @type {Tour[]} */ (items)) {
      list.append(h("li", {},
        h("a", { href: `${base}/editor/${t.id}` }, t.title),
        " ", h("span", { class: `miu-badge miu-badge--${t.status}` }, t.status),
        t.status === "published" ? h("a", { class: "miu-public", href: `${base}/t/${t.slug}`, target: "_blank", rel: "noopener" }, "view") : null));
    }
  });
}

// ---------------------------------------------------------------- tour editor

async function editorPage(/** @type {string} */ tourId) {
  /** @type {{ tour: Tour, scenes: Scene[], hotspots: Hotspot[] }} */
  const state = await api("GET", `/api/tours/${tourId}`);
  let selected = /** @type {Hotspot | undefined} */ (undefined);

  const stage = h("div", { class: "miu-stage", id: "miu-tour", "aria-label": "Panorama: click to add a hotspot, drag hotspots to move them" });
  const sceneList = h("ol", { class: "miu-scene-list" });
  const scenePanel = h("section", { class: "miu-panel miu-scene-panel" });
  const hotspotPanel = h("section", { class: "miu-panel miu-hotspot-panel", hidden: true });
  const problems = h("ul", { class: "miu-problems" });
  const publishBox = h("section", { class: "miu-panel miu-publish" });
  const tourForm = h("form", { class: "miu-panel miu-tour-form" });

  const viewer = createViewer(stage, {
    editable: true,
    panoramaUrl: (s) => `${base}/media/${s.panoramaKey}`,
    onSceneChange: () => {
      select(undefined);
      renderScenes();
    },
    onHotspotClick: (hs) => {
      select(hs);
      return false; // edit instead of navigating
    },
    onHotspotMove: (hs, at) => void run(async () => {
      replaceHotspot(await api("PATCH", `/api/hotspots/${hs.id}`, at));
    }, "Hotspot moved"),
    onPanoramaClick: (at) => void run(async () => {
      const current = viewer.scene;
      if (!current) return;
      const other = state.scenes.find((s) => s.id !== current.id);
      const body = other
        ? { kind: "link", yaw: at.yaw, pitch: at.pitch, targetSceneId: other.id, title: `Go to ${other.title}` }
        : { kind: "info", yaw: at.yaw, pitch: at.pitch, title: "New hotspot" };
      const created = await api("POST", `/api/scenes/${current.id}/hotspots`, body);
      state.hotspots.push(created);
      viewer.update(state);
      select(created);
    }, "Hotspot added — edit it in the panel"),
  });

  const bundle = () => state;
  /** @param {Hotspot} hs */
  function replaceHotspot(hs) {
    state.hotspots = state.hotspots.map((x) => (x.id === hs.id ? hs : x));
    if (selected && selected.id === hs.id) selected = hs;
    viewer.update(bundle());
  }
  async function reload() {
    Object.assign(state, await api("GET", `/api/tours/${tourId}`));
    viewer.update(bundle());
    renderAll();
  }

  // ----- tour settings -----
  function renderTourForm() {
    const title = /** @type {HTMLInputElement} */ (h("input", { name: "title", value: state.tour.title, required: true, maxLength: 120 }));
    const slug = /** @type {HTMLInputElement} */ (h("input", { name: "slug", value: state.tour.slug, required: true, pattern: "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?" }));
    const desc = /** @type {HTMLTextAreaElement} */ (h("textarea", { name: "description", maxLength: 2000, rows: 2 }));
    desc.value = state.tour.description || "";
    tourForm.replaceChildren(
      h("h2", {}, "Tour"),
      h("label", {}, "Title", title),
      h("label", {}, "Slug (public URL)", slug),
      h("label", {}, "Description", desc),
      h("button", { type: "submit" }, "Save tour"),
    );
    tourForm.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        state.tour = await api("PATCH", `/api/tours/${tourId}`, { title: title.value, slug: slug.value, description: desc.value });
        renderAll();
      }, "Tour saved");
    };
  }

  // ----- scenes -----
  function renderScenes() {
    const current = viewer.scene;
    sceneList.replaceChildren(...state.scenes.map((s, i) => {
      const isStart = state.tour.startSceneId === s.id;
      return h("li", { class: current && current.id === s.id ? "is-current" : "", "data-scene-id": s.id },
        h("button", { type: "button", class: "miu-scene-open", onclick: () => void viewer.goto(s.id), "aria-current": current && current.id === s.id ? "true" : undefined },
          isStart ? "★ " : "", s.title),
        h("span", { class: "miu-scene-actions" },
          h("button", { type: "button", title: "Move up", "aria-label": `Move ${s.title} up`, disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
          h("button", { type: "button", title: "Move down", "aria-label": `Move ${s.title} down`, disabled: i === state.scenes.length - 1, onclick: () => move(i, 1) }, "↓"),
          h("button", { type: "button", title: "Start here", "aria-label": `Start the tour at ${s.title}`, disabled: isStart, onclick: () => void run(async () => {
            state.tour = await api("PATCH", `/api/tours/${tourId}`, { startSceneId: s.id });
            renderScenes();
          }, `Tour now starts at ${s.title}`) }, "★")));
    }));
    renderScenePanel();
  }
  /** @param {number} i @param {number} dir */
  function move(i, dir) {
    const ids = state.scenes.map((s) => s.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + dir, 0, /** @type {string} */ (id));
    void run(async () => {
      state.scenes = (await api("PUT", `/api/tours/${tourId}/scene-order`, { sceneIds: ids })).scenes;
      renderScenes();
    });
  }
  function renderScenePanel() {
    const s = viewer.scene;
    if (!s) {
      scenePanel.replaceChildren(h("p", { class: "miu-empty" }, "Upload a 2:1 equirectangular panorama to create the first scene."));
      return;
    }
    const title = /** @type {HTMLInputElement} */ (h("input", { value: s.title, required: true, maxLength: 120, "aria-label": "Scene title" }));
    scenePanel.replaceChildren(
      h("h2", {}, "Scene"),
      h("form", { class: "miu-row", onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void run(async () => {
          const updated = await api("PATCH", `/api/scenes/${s.id}`, { title: title.value });
          state.scenes = state.scenes.map((x) => (x.id === s.id ? updated : x));
          viewer.update(bundle());
          renderScenes();
        }, "Scene renamed");
      } }, title, h("button", { type: "submit" }, "Rename")),
      h("button", { type: "button", onclick: () => void run(async () => {
        const cam = viewer.camera;
        const initialView = { yaw: Math.round(cam.yaw * 10) / 10, pitch: Math.round(cam.pitch * 10) / 10, fov: Math.round(cam.fov) };
        const updated = await api("PATCH", `/api/scenes/${s.id}`, { initialView });
        state.scenes = state.scenes.map((x) => (x.id === s.id ? updated : x));
        viewer.update(bundle());
      }, "Initial view saved") }, "Use current view as initial view"),
      h("button", { type: "button", class: "miu-danger", onclick: () => {
        if (!confirm(`Delete the scene "${s.title}", its hotspots and links to it?`)) return;
        void run(async () => {
          await api("DELETE", `/api/scenes/${s.id}`);
          await reload();
          const next = state.tour.startSceneId || (state.scenes[0] && state.scenes[0].id);
          if (next) await viewer.goto(next, { fade: false });
          else location.reload();
        }, "Scene deleted");
      } }, "Delete scene"),
    );
  }

  // ----- upload -----
  const file = /** @type {HTMLInputElement} */ (h("input", { type: "file", name: "panorama", accept: "image/jpeg,image/png,image/webp", required: true, "aria-label": "Panorama image" }));
  const upTitle = /** @type {HTMLInputElement} */ (h("input", { name: "title", maxLength: 120, placeholder: "Scene title (optional)", "aria-label": "New scene title" }));
  const progress = /** @type {HTMLProgressElement} */ (h("progress", { max: 1, value: 0, hidden: true }));
  const uploadForm = h("form", { class: "miu-upload", onsubmit: (/** @type {Event} */ e) => {
    e.preventDefault();
    const f = file.files && file.files[0];
    if (!f) return;
    void run(async () => {
      const scene = await uploadPanorama(f, upTitle.value, (p) => {
        progress.hidden = false;
        progress.value = p;
      });
      progress.hidden = true;
      /** @type {HTMLFormElement} */ (uploadForm).reset();
      await reload();
      await viewer.goto(scene.id);
    }, "Panorama uploaded").finally(() => (progress.hidden = true));
  } }, h("h2", {}, "Add scene"), file, upTitle, h("button", { type: "submit" }, "Upload panorama"), progress);

  /** XHR (not fetch) so upload progress can be shown. @param {File} f @param {string} title @param {(p: number) => void} onProgress @returns {Promise<Scene>} */
  function uploadPanorama(f, title, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${base}/api/tours/${tourId}/scenes${title ? `?title=${encodeURIComponent(title)}` : ""}`);
      xhr.setRequestHeader("x-requested-with", "miu-tour-editor");
      xhr.setRequestHeader("accept", "application/json");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new Error("Upload failed (network error)"));
      xhr.onload = () => {
        let body;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = undefined;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError(xhr.status, body));
      };
      const fd = new FormData();
      fd.set("panorama", f);
      xhr.send(fd);
    });
  }

  // ----- hotspot inspector -----
  /** @param {Hotspot | undefined} hs */
  function select(hs) {
    selected = hs;
    viewer.select(hs ? hs.id : "");
    renderHotspotPanel();
  }
  function renderHotspotPanel() {
    const hs = selected;
    hotspotPanel.hidden = !hs;
    if (!hs) return hotspotPanel.replaceChildren();
    const current = viewer.scene;
    const kind = /** @type {HTMLSelectElement} */ (h("select", { name: "kind" }, h("option", { value: "link" }, "Link to scene"), h("option", { value: "info" }, "Information")));
    kind.value = hs.kind;
    const target = /** @type {HTMLSelectElement} */ (h("select", { name: "targetSceneId" }, h("option", { value: "" }, "— choose a scene —"),
      ...state.scenes.filter((s) => !current || s.id !== current.id).map((s) => h("option", { value: s.id }, s.title))));
    target.value = hs.targetSceneId || "";
    const title = /** @type {HTMLInputElement} */ (h("input", { name: "title", value: hs.title || "", maxLength: 120 }));
    const text = /** @type {HTMLTextAreaElement} */ (h("textarea", { name: "text", maxLength: 2000, rows: 3 }));
    text.value = hs.text || "";
    const url = /** @type {HTMLInputElement} */ (h("input", { name: "url", type: "url", value: hs.url || "", placeholder: "https://…" }));
    const targetRow = h("label", {}, "Target scene", target);
    const infoRows = [h("label", {}, "Text", text), h("label", {}, "Link (optional)", url)];
    const sync = () => {
      targetRow.hidden = kind.value !== "link";
      for (const r of infoRows) r.hidden = kind.value !== "info";
    };
    kind.addEventListener("change", sync);
    sync();
    hotspotPanel.replaceChildren(
      h("h2", {}, "Hotspot"),
      h("form", { onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void run(async () => {
          const k = kind.value;
          replaceHotspot(await api("PATCH", `/api/hotspots/${hs.id}`, {
            kind: k,
            title: title.value || null,
            targetSceneId: k === "link" ? target.value || null : null,
            text: k === "info" ? text.value || null : null,
            url: k === "info" ? url.value || null : null,
          }));
          renderHotspotPanel();
        }, "Hotspot saved");
      } },
      h("label", {}, "Type", kind), targetRow, h("label", {}, "Title", title), ...infoRows,
      h("p", { class: "miu-hint" }, `Position: yaw ${hs.yaw}°, pitch ${hs.pitch}° — drag the marker to move it.`),
      h("div", { class: "miu-row" },
        h("button", { type: "submit" }, "Save hotspot"),
        h("button", { type: "button", class: "miu-danger", onclick: () => void run(async () => {
          await api("DELETE", `/api/hotspots/${hs.id}`);
          state.hotspots = state.hotspots.filter((x) => x.id !== hs.id);
          select(undefined);
          viewer.update(bundle());
        }, "Hotspot deleted") }, "Delete"),
        h("button", { type: "button", onclick: () => select(undefined) }, "Close"))),
    );
  }

  // ----- publishing -----
  function renderPublish() {
    const published = state.tour.status === "published";
    publishBox.replaceChildren(
      h("h2", {}, "Publish"),
      h("p", {}, "Status: ", h("span", { class: `miu-badge miu-badge--${state.tour.status}` }, state.tour.status), " ",
        h("a", { href: `${base}/t/${state.tour.slug}`, target: "_blank", rel: "noopener" }, published ? "Open public page" : "Preview")),
      h("button", { type: "button", class: published ? "" : "miu-primary", onclick: () => void run(async () => {
        problems.replaceChildren();
        try {
          state.tour = await api("POST", `/api/tours/${tourId}/${published ? "unpublish" : "publish"}`);
        } catch (err) {
          if (err instanceof ApiError && err.body && Array.isArray(err.body.problems)) {
            problems.replaceChildren(...err.body.problems.map((/** @type {{ message: string }} */ p) => h("li", {}, p.message)));
            throw new ApiError(422, { detail: "Fix these problems, then publish again." });
          }
          throw err;
        }
        renderPublish();
      }, published ? "Tour unpublished" : "Tour published!") }, published ? "Unpublish" : "Publish"),
      problems,
    );
  }

  function renderAll() {
    document.title = `${state.tour.title} · Tour editor`;
    renderTourForm();
    renderScenes();
    renderPublish();
    renderHotspotPanel();
  }

  app.replaceChildren(h("div", { class: "miu-editor" },
    h("aside", { class: "miu-side" },
      h("a", { href: `${base}/editor`, class: "miu-back" }, "← All tours"),
      tourForm,
      h("section", { class: "miu-panel" }, h("h2", {}, "Scenes"), sceneList),
      uploadForm,
      publishBox),
    h("main", { class: "miu-main" }, stage, h("p", { class: "miu-hint" }, "Drag to look around · click the panorama to add a hotspot · click a hotspot to edit it, drag to move it"), status),
    h("aside", { class: "miu-side miu-inspector" }, scenePanel, hotspotPanel)));
  renderAll();
  await viewer.load(state);
  renderScenes();
  /** @type {any} */ (window).miuEditor = { state, viewer, api, select: (/** @type {string} */ id) => select(state.hotspots.find((x) => x.id === id)) };
}

if (data.mode === "tours") void toursPage();
else if (data.mode === "editor") void editorPage(data.tourId).catch((err) => {
  console.error(err);
  app.replaceChildren(h("p", { class: "miu-status is-error" }, `Could not open the editor: ${err.message}`));
});
