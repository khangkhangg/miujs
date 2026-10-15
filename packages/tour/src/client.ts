// Browser code for the viewer page, shipped inline (no build step) as ES modules under the
// page's CSP nonce. Kept dependency-free: the 360° and 3D viewers come from the import map
// (Photo Sphere Viewer) and <model-viewer>. Written without template literals so it can live
// in a TypeScript string.

/** The viewer: loads the manifest, drives Photo Sphere Viewer / <model-viewer>, analytics. */
export const VIEWER_JS = String.raw`
const $ = (id) => document.getElementById(id);
const cfg = JSON.parse($("miu-tour-config").textContent);
const root = $("miu-tour");
const stage = root.querySelector(".miu-tour-stage");
const statusEl = root.querySelector(".miu-tour-status");
const panel = root.querySelector(".miu-tour-panel");
const panelBody = root.querySelector(".miu-tour-panel-body");
const FACE = { front: "f", back: "b", left: "l", right: "r", top: "u", bottom: "d" };
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const deg = (r) => (r * 180) / Math.PI;
const handlers = { change: [], input: [], point: [] };
const emit = (name, data) => handlers[name].forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

let manifest = null;
let current = null;
let enteredAt = 0;
let psv = null, psvEl = null, vt = null, markers = null, mv = null, imgWrap = null;

async function fetchManifest() {
  const r = await fetch(cfg.manifestUrl, { credentials: "same-origin" });
  if (!r.ok) throw new Error("manifest " + r.status);
  return r.json();
}
const byId = (id) => manifest.scenes.find((s) => s.id === id);
const ready = (sc) => sc && sc.asset && sc.asset.status === "ready";

// ---- analytics (no PII: a random per-tab session id, scene/hotspot ids, dwell time) ----
const sid = (() => {
  const make = () => crypto.randomUUID().replace(/-/g, "");
  try {
    let s = sessionStorage.getItem("miu-tour-sid");
    if (!s) { s = make(); sessionStorage.setItem("miu-tour-sid", s); }
    return s;
  } catch { return make(); }
})();
let outbox = [];
function track(e) {
  if (!manifest || !manifest.analytics) return;
  outbox.push(e);
  if (outbox.length >= 20) flush(false);
}
function flush(beacon) {
  if (!outbox.length || !manifest || !manifest.analytics) return;
  const body = JSON.stringify({ sessionId: sid, events: outbox.splice(0, 50) });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon(manifest.analytics.url, new Blob([body], { type: "application/json" }));
  else fetch(manifest.analytics.url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
}
setInterval(() => flush(false), 15000);
addEventListener("pagehide", () => { leave(); flush(true); });

function leave() {
  if (current) track({ type: "scene", sceneId: current, dwellMs: Math.round(performance.now() - enteredAt) });
}
function enter(id) {
  if (current === id) return;
  leave();
  current = id;
  enteredAt = performance.now();
  root.querySelectorAll("[data-scene]").forEach((el) => el.toggleAttribute("aria-current", el.dataset.scene === id));
  emit("change");
}

// ---- hotspot panel ----
function openHotspot(sc, h) {
  track({ type: "hotspot", sceneId: sc.id, hotspotId: h.id });
  if (h.kind === "link") return go(h.targetSceneId);
  if (h.kind === "url") return void window.open(h.url, "_blank", "noopener,noreferrer");
  let inner = h.title ? "<h2>" + esc(h.title) + "</h2>" : "";
  if (h.kind === "info") inner += h.bodyHtml || "";
  if (h.kind === "media" && h.media) {
    const t = h.media.contentType || "";
    if (t.startsWith("image/")) inner += '<img src="' + esc(h.media.url) + '" alt="' + esc(h.title) + '">';
    else if (t.startsWith("video/")) inner += '<video controls playsinline src="' + esc(h.media.url) + '"></video>';
    else inner += '<a href="' + esc(h.media.url) + '" target="_blank" rel="noopener">Open</a>';
  }
  panelBody.innerHTML = inner;
  panel.hidden = false;
}
root.querySelector(".miu-tour-close").addEventListener("click", () => { panel.hidden = true; panelBody.replaceChildren(); });

// ---- 360° panoramas (Photo Sphere Viewer + virtual tour plugin) ----
function panoramaFor(sc) {
  const a = () => byId(sc.id).asset;
  const first = a();
  if (first.layout === "cube") {
    const top = first.levels.length - 1;
    return {
      faceSize: first.faceSize,
      nbTiles: Math.max(1, Math.ceil(first.faceSize / first.tileSize)),
      levels: first.levels.map((l) => ({ faceSize: l.size, nbTiles: Math.max(1, Math.ceil(l.size / first.tileSize)) })),
      tileUrl: (face, col, row, level) => a().tiles.replace("{level}", String(level == null ? top : level)).replace("{face}", FACE[face] || face).replace("{row}", String(row)).replace("{col}", String(col)),
    };
  }
  if (first.layout === "equirect-tiles") {
    const top = first.levels[first.levels.length - 1];
    return {
      width: top.width, cols: top.cols, rows: top.rows,
      levels: first.levels,
      baseUrl: first.preview,
      tileUrl: (col, row, level) => a().tiles.replace("{level}", String(level == null ? first.levels.length - 1 : level)).replace("{row}", String(row)).replace("{col}", String(col)),
    };
  }
  const want = Math.min(8192, (window.devicePixelRatio || 1) * screen.width * 4);
  const pick = first.sources.find((s) => s.width >= want) || first.sources[first.sources.length - 1];
  return pick.url;
}

const pos = (p) => ({ yaw: p.yaw + "deg", pitch: p.pitch + "deg" });

function nodeFor(sc, layout) {
  const linkable = (id) => { const t = byId(id); return t && t.type === "pano360" && ready(t) && t.asset.layout === layout; };
  return {
    id: sc.id,
    name: sc.title,
    caption: sc.title,
    panorama: panoramaFor(sc),
    links: sc.hotspots.filter((h) => h.kind === "link" && linkable(h.targetSceneId)).map((h) => ({ nodeId: h.targetSceneId, position: pos(h.position) })),
    markers: sc.hotspots.filter((h) => !(h.kind === "link" && linkable(h.targetSceneId))).map((h) => ({
      id: h.id,
      position: pos(h.position),
      html: '<span class="miu-tour-hs miu-tour-hs-' + esc(h.kind) + '"></span>',
      size: { width: 32, height: 32 },
      anchor: "center center",
      tooltip: h.title ? esc(h.title) : undefined,
      data: { scene: sc.id, hotspot: h },
    })),
  };
}

async function ensurePano(startId) {
  if (psv) return;
  const [{ Viewer }, { MarkersPlugin }, { VirtualTourPlugin }] = await Promise.all([
    import("@photo-sphere-viewer/core"),
    import("@photo-sphere-viewer/markers-plugin"),
    import("@photo-sphere-viewer/virtual-tour-plugin"),
  ]);
  const start = byId(startId);
  const layout = start.asset.layout;
  let adapter;
  if (layout === "cube") adapter = (await import("@photo-sphere-viewer/cubemap-tiles-adapter")).CubemapTilesAdapter;
  else if (layout === "equirect-tiles") adapter = (await import("@photo-sphere-viewer/equirectangular-tiles-adapter")).EquirectangularTilesAdapter;
  const nodes = manifest.scenes.filter((s) => s.type === "pano360" && ready(s) && s.asset.layout === layout).map((s) => nodeFor(s, layout));
  psvEl = document.createElement("div");
  psvEl.className = "miu-tour-psv";
  stage.append(psvEl);
  psv = new Viewer({
    container: psvEl,
    adapter,
    navbar: ["zoom", "move", "caption", "fullscreen"],
    defaultYaw: start.initialView.yaw + "deg",
    defaultPitch: start.initialView.pitch + "deg",
    plugins: [MarkersPlugin, [VirtualTourPlugin, { positionMode: "manual", renderMode: "3d", nodes, startNodeId: startId }]],
  });
  markers = psv.getPlugin(MarkersPlugin);
  vt = psv.getPlugin(VirtualTourPlugin);
  vt.addEventListener("node-changed", ({ node }) => { look(byId(node.id).initialView); enter(node.id); });
  markers.addEventListener("select-marker", ({ marker }) => { const d = marker.config.data; if (d && d.hotspot) openHotspot(byId(d.scene), d.hotspot); });
  psv.addEventListener("position-updated", () => emit("change"));
  psv.addEventListener("zoom-updated", () => emit("change"));
  psv.addEventListener("dblclick", ({ data }) => emit("point", { scene: current, yaw: deg(data.yaw), pitch: deg(data.pitch) }));
  psvEl.addEventListener("pointerdown", () => emit("input"));
  psvEl.addEventListener("wheel", () => emit("input"), { passive: true });
}

function look(v) {
  if (!v) return;
  if (psv && byId(current) && byId(current).type === "pano360") {
    psv.rotate({ yaw: v.yaw + "deg", pitch: v.pitch + "deg" });
    if (v.fov && psv.dataHelper && psv.dataHelper.fovToZoomLevel) psv.zoom(psv.dataHelper.fovToZoomLevel(v.fov));
  } else if (mv && !mv.hidden) {
    mv.cameraOrbit = v.yaw + "deg " + (90 - v.pitch) + "deg auto";
    if (v.fov) mv.fieldOfView = v.fov + "deg";
  }
}

function view() {
  const sc = byId(current);
  if (!sc) return null;
  if (sc.type === "pano360" && psv) {
    const p = psv.getPosition();
    let yaw = deg(p.yaw);
    if (yaw > 180) yaw -= 360;
    return { scene: sc.id, yaw, pitch: deg(p.pitch), fov: psv.state.vFov };
  }
  if (sc.type === "model3d" && mv && mv.getCameraOrbit) {
    const o = mv.getCameraOrbit();
    let yaw = deg(o.theta);
    if (yaw > 180) yaw -= 360;
    return { scene: sc.id, yaw, pitch: 90 - deg(o.phi), fov: mv.getFieldOfView ? mv.getFieldOfView() : 45 };
  }
  return { scene: sc.id, yaw: 0, pitch: 0, fov: 75 };
}

// ---- 3D models (<model-viewer>) and plain images ----
function showModel(sc) {
  if (!mv) {
    mv = document.createElement("model-viewer");
    mv.className = "miu-tour-model";
    mv.setAttribute("camera-controls", "");
    mv.setAttribute("touch-action", "pan-y");
    mv.setAttribute("ar", "");
    mv.addEventListener("camera-change", (e) => { emit("change"); if (e.detail && e.detail.source === "user-interaction") emit("input"); });
    stage.append(mv);
  }
  mv.hidden = false;
  mv.setAttribute("alt", sc.title);
  mv.setAttribute("src", sc.asset.url);
  mv.replaceChildren();
  for (const h of sc.hotspots) {
    const b = document.createElement("button");
    b.type = "button";
    b.slot = "hotspot-" + h.id;
    b.className = "miu-tour-hs miu-tour-hs-" + h.kind;
    b.dataset.position = h.position.x + "m " + h.position.y + "m " + h.position.z + "m";
    b.textContent = h.title || "";
    b.addEventListener("click", () => openHotspot(sc, h));
    mv.append(b);
  }
}

function showImage(sc) {
  if (!imgWrap) { imgWrap = document.createElement("div"); imgWrap.className = "miu-tour-image"; stage.append(imgWrap); }
  imgWrap.hidden = false;
  imgWrap.replaceChildren();
  const img = document.createElement("img");
  img.src = sc.asset.url;
  img.alt = sc.title;
  imgWrap.append(img);
  for (const h of sc.hotspots) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "miu-tour-hs miu-tour-hs-" + h.kind;
    b.style.left = h.position.x * 100 + "%";
    b.style.top = h.position.y * 100 + "%";
    b.setAttribute("aria-label", h.title || h.kind);
    b.addEventListener("click", () => openHotspot(sc, h));
    imgWrap.append(b);
  }
}

async function go(id, v) {
  const sc = byId(id);
  if (!sc) return;
  for (const el of [psvEl, mv, imgWrap]) if (el) el.hidden = true;
  if (!ready(sc)) {
    statusEl.textContent = sc.asset && sc.asset.status !== "failed" ? "This scene is still being processed (" + Math.round((sc.asset.progress || 0) * 100) + "%)." : "This scene is not available yet.";
    statusEl.hidden = false;
    enter(id);
    return;
  }
  statusEl.hidden = true;
  if (sc.type === "pano360") {
    await ensurePano(id);
    psvEl.hidden = false;
    if (vt.getCurrentNode() && vt.getCurrentNode().id !== id) await vt.setCurrentNode(id);
    enter(id);
    look(v || sc.initialView);
  } else if (sc.type === "model3d") {
    showModel(sc);
    enter(id);
    look(v || sc.initialView);
  } else {
    showImage(sc);
    enter(id);
  }
}

function highlight(p) {
  if (!p || p.scene !== current || !markers) return;
  try { markers.removeMarker("miu-tour-pointer"); } catch {}
  markers.addMarker({ id: "miu-tour-pointer", position: pos(p), html: '<span class="miu-tour-pointer"></span>', size: { width: 48, height: 48 }, anchor: "center center" });
  setTimeout(() => { try { markers.removeMarker("miu-tour-pointer"); } catch {} }, 3000);
}

// ---- floor plan and scene list ----
root.querySelectorAll(".miu-tour-marker").forEach((b) => {
  b.style.left = Number(b.dataset.x) * 100 + "%";
  b.style.top = Number(b.dataset.y) * 100 + "%";
});
root.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scene]");
  if (b && root.contains(b)) { e.preventDefault(); emit("input"); go(b.dataset.scene); }
});

// Self-hosted decoders for compressed models (privacy: "strict" needs every byte from you).
if (cfg.decoders) {
  customElements.whenDefined("model-viewer").then(() => {
    const MV = customElements.get("model-viewer");
    if (cfg.decoders.draco) MV.dracoDecoderLocation = cfg.decoders.draco;
    if (cfg.decoders.ktx2) MV.ktx2TranscoderLocation = cfg.decoders.ktx2;
    if (cfg.decoders.meshopt) MV.meshoptDecoderLocation = cfg.decoders.meshopt;
  });
}

try {
  const inline = $("miu-tour-manifest");
  manifest = inline ? JSON.parse(inline.textContent) : await fetchManifest();
} catch (e) {
  statusEl.textContent = "This tour could not be loaded.";
  throw e;
}
// Signed URLs expire: refresh the manifest a minute before (tile URL closures read the latest).
const refresh = () => {
  const ms = Math.max(30000, manifest.expiresAt * 1000 - Date.now() - 60000);
  setTimeout(async () => { try { manifest = await fetchManifest(); } catch {} refresh(); }, Math.min(ms, 2147483647));
};
refresh();
track({ type: "view" });
window.miuTour = {
  manifest: () => manifest,
  scene: () => current,
  view,
  go,
  look,
  highlight,
  on: (name, fn) => handlers[name] && handlers[name].push(fn),
};
dispatchEvent(new Event("miu-tour-ready"));
if (manifest.tour.startSceneId) await go(manifest.tour.startSceneId);
else statusEl.textContent = "This tour has no scenes yet.";
`;
/**
 * Live guided tours: resolves the 6-digit join code and joins the `guidedTour` room with the
 * rooms plugin's own browser client (served at /rooms/_client/<hash>.js). The guide's link
 * carries `#guide=<token>` (never sent to servers in URLs it navigates to); it is passed as a
 * join parameter and checked by the room at join. Followers follow until they move the view
 * themselves ("detach"), then can rejoin. Followers can raise a hand; the guide can point.
 */
export const LIVE_JS = String.raw`
const cfg = JSON.parse(document.getElementById("miu-tour-live").textContent);
const ui = document.querySelector(".miu-tour-live");
const statusEl = ui.querySelector("[data-live=status]");
const detachBtn = ui.querySelector("[data-live=detach]");
const handBtn = ui.querySelector("[data-live=raise]");
const handsEl = ui.querySelector("[data-live=hands]");
const endBtn = ui.querySelector("[data-live=end]");
const guideToken = new URLSearchParams(location.hash.slice(1)).get("guide");
let guide = false, detached = false, hand = false, ended = false, lastSent = 0, pending = null;

const tourReady = () => window.miuTour ? Promise.resolve(window.miuTour) : new Promise((r) => addEventListener("miu-tour-ready", () => r(window.miuTour), { once: true }));

async function start() {
  const r = await fetch(cfg.roomsPath + "/code/" + encodeURIComponent(cfg.code));
  if (!r.ok) { statusEl.textContent = "This live tour has ended, or the code is wrong."; return; }
  const target = await r.json();
  if (target.type !== "guidedTour") return;
  const [{ connect }, tour] = await Promise.all([import(cfg.clientUrl), tourReady()]);
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + cfg.roomsPath + "/" + encodeURIComponent(target.type) + "/" + encodeURIComponent(target.id);
  const room = connect(url, { name: guideToken ? "Guide" : "Guest", role: "spectator", params: guideToken ? { guide: guideToken } : undefined });
  const send = (type, data) => room.send(type, data || {});

  function renderHands(list) {
    handsEl.replaceChildren();
    for (const h of list || []) {
      const li = document.createElement("li");
      li.textContent = h.name + " ";
      if (guide) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Answer";
        b.addEventListener("click", () => send("ack", { playerId: h.id }));
        li.append(b);
      }
      handsEl.append(li);
    }
    handsEl.hidden = !guide || !(list && list.length);
  }

  room.on("error", (e) => { statusEl.textContent = e.message; });
  room.on("close", (e) => { statusEl.textContent = ended ? "The guide ended this live tour." : e.willReconnect ? "Reconnecting..." : "Disconnected from the live tour."; });
  room.on("guide", (d) => {
    guide = !!(room.me && d && d.id === room.me.id);
    ui.classList.toggle("is-guide", guide);
    handBtn.hidden = guide;
    endBtn.hidden = !guide;
    statusEl.textContent = guide ? "You are guiding. " + d.followers + " following." : d ? "Following " + d.name + "." : "Waiting for the guide.";
  });
  room.on("camera", (d) => {
    if (guide || detached || !d) return;
    if (tour.scene() !== d.scene) tour.go(d.scene, d);
    else tour.look(d);
  });
  room.on("pointer", (d) => { if (!guide) tour.highlight(d); });
  room.on("hands", renderHands);
  room.on("handAck", () => { hand = false; handBtn.setAttribute("aria-pressed", "false"); });
  room.on("ended", () => { ended = true; room.close(); });

  // The guide sends the camera at most 10 times a second (the room enforces it too).
  tour.on("change", () => {
    if (!guide) return;
    const sendNow = () => { const v = tour.view(); if (v) { lastSent = Date.now(); send("camera", v); } };
    const wait = 100 - (Date.now() - lastSent);
    if (wait <= 0) sendNow();
    else if (!pending) pending = setTimeout(() => { pending = null; sendNow(); }, wait);
  });
  tour.on("point", (p) => { if (guide && p) send("pointer", p); });
  // Followers detach as soon as they move the view themselves.
  tour.on("input", () => { if (!guide && !detached) { detached = true; detachBtn.hidden = false; } });
  detachBtn.addEventListener("click", () => { detached = false; detachBtn.hidden = true; send("sync"); });
  handBtn.addEventListener("click", () => { hand = !hand; handBtn.setAttribute("aria-pressed", String(hand)); send(hand ? "raise" : "lower"); });
  endBtn.addEventListener("click", () => send("end"));
}

start().catch((e) => { statusEl.textContent = "The live tour could not start."; console.error(e); });
`;
