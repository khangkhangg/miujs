// @ts-check
/**
 * MiuJS tour viewer: a dependency-free WebGL equirectangular panorama viewer with DOM hotspots.
 *
 *   import { createViewer } from "/assets/viewer.js";
 *   const viewer = createViewer(element, { panoramaUrl: (scene) => "/media/" + scene.panoramaKey });
 *   await viewer.load({ tour, scenes, hotspots });
 *
 * Rendering: one full-screen triangle pair; the fragment shader turns each pixel into a view ray (camera basis
 * from math.js, the same functions the server tests check) and samples the equirectangular texture. Hotspots
 * are real <button>s positioned every frame with yawPitchToScreen(), so they are focusable, screen-reader
 * friendly and inspectable in DevTools. On a page rendered by the tour kit, `window.miuTour` exposes the live
 * viewer for debugging: miuTour.scene, miuTour.camera, miuTour.goto(id).
 */
import { clamp, dragDelta, normalizeCamera, planeScale, cameraBasis, screenToYawPitch, wrapYaw, yawPitchToScreen } from "./math.js";

/**
 * @typedef {{ yaw: number, pitch: number, fov: number }} Camera
 * @typedef {{ id: string, title: string, panoramaKey: string, panoramaUrl?: string, width: number, height: number, initialView: Camera, order: number }} Scene
 * @typedef {{ id: string, sceneId: string, kind: "link" | "info", yaw: number, pitch: number, targetSceneId?: string, title?: string, text?: string, url?: string }} Hotspot
 * @typedef {{ tour: { title: string, startSceneId?: string, slug?: string }, scenes: Scene[], hotspots: Hotspot[] }} Bundle
 * @typedef {{
 *   panoramaUrl?: (scene: Scene) => string,
 *   onHotspotClick?: (h: Hotspot, ev: Event) => boolean | void,
 *   onPanoramaClick?: (at: { yaw: number, pitch: number, x: number, y: number }) => void,
 *   onHotspotMove?: (h: Hotspot, at: { yaw: number, pitch: number }) => void,
 *   onSceneChange?: (scene: Scene) => void,
 *   onCameraChange?: (camera: Camera) => void,
 *   editable?: boolean,
 *   deepLink?: boolean,
 *   fadeMs?: number,
 * }} ViewerOptions
 */

const VERT = `attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
/** @param {string} precision */
const FRAG = (precision) => `precision ${precision} float;
uniform sampler2D tex; uniform vec3 f; uniform vec3 r; uniform vec3 u; uniform vec2 s; varying vec2 v;
void main() {
  vec3 d = normalize(f + r * (v.x * s.x) + u * (v.y * s.y));
  float lon = atan(d.x, d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  gl_FragColor = vec4(texture2D(tex, vec2(0.5 + lon / 6.28318530718, 0.5 - lat / 3.14159265359)).rgb, 1.0);
}`;

/** Shared image cache: preloading a linked scene makes the later switch instant. @type {Map<string, Promise<HTMLImageElement>>} */
const images = new Map();
/** @param {string} url */
export function loadImage(url) {
  let p = images.get(url);
  if (!p) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    p = img.decode().then(() => img);
    p.catch(() => images.delete(url));
    images.set(url, p);
  }
  return p;
}

/** @param {string} tag @param {string} [cls] @param {Record<string, string>} [attrs] */
function el(tag, cls, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/**
 * @param {HTMLElement} root
 * @param {ViewerOptions} [options]
 */
export function createViewer(root, options = {}) {
  const opts = { fadeMs: 180, ...options };
  root.classList.add("miu-viewer");
  if (!root.hasAttribute("tabindex")) root.tabIndex = 0;
  const canvas = /** @type {HTMLCanvasElement} */ (el("canvas", "miu-canvas"));
  const layer = el("div", "miu-hotspots");
  const fade = el("div", "miu-fade");
  const message = el("div", "miu-message", { role: "status", "aria-live": "polite" });
  const popover = el("div", "miu-popover", { role: "dialog", "aria-modal": "false", hidden: "" });
  root.append(canvas, layer, fade, popover, message);

  /** @type {Bundle} */ let bundle = { tour: { title: "" }, scenes: [], hotspots: [] };
  /** @type {Scene | undefined} */ let scene;
  /** @type {Camera} */ let camera = { yaw: 0, pitch: 0, fov: 75 };
  /** @type {Map<string, HTMLButtonElement>} */ const markers = new Map();
  let selectedId = "";
  let dirty = true;
  let frame = 0;
  let navToken = 0;
  let destroyed = false;

  // ---------- WebGL ----------
  /** @type {WebGLRenderingContext | null} */ let gl = null;
  /** @type {WebGLProgram | null} */ let program = null;
  /** @type {WebGLTexture | null} */ let texture = null;
  /** @type {Record<string, WebGLUniformLocation | null>} */ let loc = {};
  /** @type {HTMLImageElement | HTMLCanvasElement | null} */ let currentImage = null;

  function initGl() {
    gl = /** @type {WebGLRenderingContext | null} */ (canvas.getContext("webgl2", { antialias: false, alpha: false }) || canvas.getContext("webgl", { antialias: false, alpha: false }));
    if (!gl) return false;
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const compile = (/** @type {number} */ type, /** @type {string} */ src) => {
      const g = /** @type {WebGLRenderingContext} */ (gl);
      const sh = /** @type {WebGLShader} */ (g.createShader(type));
      g.shaderSource(sh, src);
      g.compileShader(sh);
      if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error("miu-tour shader: " + g.getShaderInfoLog(sh));
      return sh;
    };
    program = /** @type {WebGLProgram} */ (gl.createProgram());
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG(hp && hp.precision > 0 ? "highp" : "mediump")));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("miu-tour link: " + gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    loc = { f: gl.getUniformLocation(program, "f"), r: gl.getUniformLocation(program, "r"), u: gl.getUniformLocation(program, "u"), s: gl.getUniformLocation(program, "s") };
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Non-power-of-two safe in WebGL1: clamp and no mipmaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (currentImage) upload(currentImage);
    return true;
  }

  /** Upload a panorama, downscaling first if the GPU's MAX_TEXTURE_SIZE is smaller (common on phones). @param {HTMLImageElement | HTMLCanvasElement} img */
  function upload(img) {
    currentImage = img;
    if (!gl) return;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    /** @type {TexImageSource} */ let src = img;
    if (img.width > max) {
      const c = document.createElement("canvas");
      c.width = max;
      c.height = Math.round((img.height * max) / img.width);
      /** @type {CanvasRenderingContext2D} */ (c.getContext("2d")).drawImage(img, 0, 0, c.width, c.height);
      src = c;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    gl = null;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    initGl();
    requestRender();
  });

  const webgl = (() => {
    try {
      return initGl();
    } catch (err) {
      console.error(err);
      return false;
    }
  })();
  if (!webgl) {
    root.classList.add("miu-no-webgl");
    showMessage("This browser cannot display 360° panoramas (WebGL is unavailable or disabled). Showing the flat image instead.");
  }

  // ---------- rendering ----------
  const view = () => ({ width: root.clientWidth || 1, height: root.clientHeight || 1 });

  function requestRender() {
    dirty = true;
    if (!frame && !destroyed) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = 0;
    if (!dirty) return;
    dirty = false;
    const v = view();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(v.width * dpr);
    const h = Math.round(v.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (gl && program && currentImage) {
      const b = cameraBasis(camera.yaw, camera.pitch);
      const s = planeScale(camera, v);
      gl.viewport(0, 0, w, h);
      gl.uniform3fv(loc.f, b.forward);
      gl.uniform3fv(loc.r, b.right);
      gl.uniform3fv(loc.u, b.up);
      gl.uniform2f(loc.s, s[0], s[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    placeMarkers(v);
  }

  /** @param {{ width: number, height: number }} v */
  function placeMarkers(v) {
    for (const h of hotspotsHere()) {
      const m = markers.get(h.id);
      if (!m || m.classList.contains("is-dragging")) continue;
      const p = yawPitchToScreen(h.yaw, h.pitch, camera, v);
      const on = p.visible && p.x > -40 && p.y > -40 && p.x < v.width + 40 && p.y < v.height + 40;
      m.hidden = !on;
      if (on) m.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  new ResizeObserver(requestRender).observe(root);

  // ---------- scenes & hotspots ----------
  const hotspotsHere = () => (scene ? bundle.hotspots.filter((h) => h.sceneId === (scene && scene.id)) : []);
  const sceneById = (/** @type {string | undefined} */ id) => bundle.scenes.find((s) => s.id === id);
  const urlOf = (/** @type {Scene} */ s) => (opts.panoramaUrl ? opts.panoramaUrl(s) : s.panoramaUrl || "");

  function buildMarkers() {
    closePopover();
    layer.textContent = "";
    markers.clear();
    for (const h of hotspotsHere()) {
      const target = h.kind === "link" ? sceneById(h.targetSceneId) : undefined;
      const label = h.title || (h.kind === "link" ? (target ? `Go to ${target.title}` : "Link (no target)") : "Information");
      const b = /** @type {HTMLButtonElement} */ (el("button", `miu-hotspot miu-hotspot--${h.kind}`, { type: "button", "aria-label": label, title: label, "data-hotspot-id": h.id }));
      const tag = el("span", "miu-hotspot-label");
      tag.textContent = label;
      b.append(el("span", "miu-hotspot-icon", { "aria-hidden": "true" }), tag);
      if (h.id === selectedId) b.classList.add("is-selected");
      bindMarker(b, h);
      layer.append(b);
      markers.set(h.id, b);
    }
    requestRender();
  }

  /** @param {HTMLButtonElement} b @param {Hotspot} h */
  function bindMarker(b, h) {
    let start = /** @type {{ x: number, y: number, id: number } | null} */ (null);
    let dragged = false;
    b.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (!opts.editable) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragged = false;
      b.setPointerCapture(e.pointerId);
    });
    b.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (!dragged && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      dragged = true;
      b.classList.add("is-dragging");
      const r = root.getBoundingClientRect();
      b.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px) translate(-50%, -50%)`;
    });
    const end = (/** @type {PointerEvent} */ e) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      if (!dragged) return;
      b.classList.remove("is-dragging");
      const r = root.getBoundingClientRect();
      const at = screenToYawPitch(e.clientX - r.left, e.clientY - r.top, camera, view());
      h.yaw = round(at.yaw);
      h.pitch = round(at.pitch);
      requestRender();
      if (e.type === "pointerup" && opts.onHotspotMove) opts.onHotspotMove(h, { yaw: h.yaw, pitch: h.pitch });
    };
    b.addEventListener("pointerup", end);
    b.addEventListener("pointercancel", end);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      activate(h, b, e);
    });
  }

  /** @param {Hotspot} h @param {HTMLElement} b @param {Event} e */
  function activate(h, b, e) {
    if (opts.onHotspotClick && opts.onHotspotClick(h, e) === false) return;
    if (h.kind === "link" && h.targetSceneId) void goto(h.targetSceneId);
    else if (h.kind === "info") openPopover(h, b);
  }

  /**
   * Show a scene. Fades out, loads (or reuses the preloaded) panorama, then fades in.
   * @param {string} id @param {{ camera?: Partial<Camera>, fade?: boolean }} [o]
   */
  async function goto(id, o = {}) {
    const next = sceneById(id);
    if (!next) throw new Error(`miu-tour: no scene ${id}`);
    const token = ++navToken;
    const useFade = o.fade !== false && !!scene && (opts.fadeMs ?? 0) > 0;
    if (useFade) {
      fade.classList.add("is-on");
      await sleep(opts.fadeMs ?? 0);
    }
    showMessage(scene ? "" : "Loading panorama…");
    let img;
    try {
      img = await loadImage(urlOf(next));
    } catch {
      if (token === navToken) {
        showMessage(`Could not load the panorama for "${next.title}".`);
        fade.classList.remove("is-on");
      }
      return;
    }
    if (token !== navToken || destroyed) return;
    scene = next;
    if (webgl) upload(img);
    else showFlat(img);
    camera = normalizeCamera({ ...next.initialView, ...o.camera });
    showMessage("");
    buildMarkers();
    fade.classList.remove("is-on");
    root.dataset.scene = next.id;
    if (opts.onSceneChange) opts.onSceneChange(next);
    cameraChanged();
    preloadNeighbours();
  }

  function preloadNeighbours() {
    for (const h of hotspotsHere()) {
      const t = h.kind === "link" ? sceneById(h.targetSceneId) : undefined;
      if (t) loadImage(urlOf(t)).catch(() => {});
    }
  }

  /** @param {HTMLImageElement} img */
  function showFlat(img) {
    let flat = root.querySelector(".miu-flat");
    if (!flat) {
      flat = el("div", "miu-flat");
      root.append(flat);
    }
    const copy = /** @type {HTMLImageElement} */ (img.cloneNode());
    copy.alt = scene ? `Panorama: ${scene.title}` : "Panorama";
    flat.replaceChildren(copy);
  }

  // ---------- info popover ----------
  /** @type {HTMLElement | null} */ let popoverOpener = null;
  /** @param {Hotspot} h @param {HTMLElement} opener */
  function openPopover(h, opener) {
    popover.textContent = "";
    const id = `miu-pop-${h.id}`;
    const heading = el("h2", "miu-popover-title", { id });
    heading.textContent = h.title || "Information";
    popover.setAttribute("aria-labelledby", id);
    popover.append(heading);
    if (h.text) {
      const p = el("p", "miu-popover-text");
      p.textContent = h.text;
      popover.append(p);
    }
    if (h.url && /^https?:\/\//i.test(h.url)) {
      const a = /** @type {HTMLAnchorElement} */ (el("a", "miu-popover-link", { href: h.url, target: "_blank", rel: "noopener noreferrer" }));
      a.textContent = "Open link";
      popover.append(a);
    }
    const close = el("button", "miu-popover-close", { type: "button", "aria-label": "Close" });
    close.textContent = "×";
    close.addEventListener("click", closePopover);
    popover.append(close);
    popover.hidden = false;
    popoverOpener = opener;
    close.focus();
  }
  function closePopover() {
    if (popover.hidden) return;
    popover.hidden = true;
    if (popoverOpener && popoverOpener.isConnected) popoverOpener.focus();
    popoverOpener = null;
  }

  // ---------- camera & input ----------
  let hashTimer = 0;
  function cameraChanged() {
    requestRender();
    if (opts.onCameraChange) opts.onCameraChange({ ...camera });
    if (opts.deepLink && scene) {
      clearTimeout(hashTimer);
      hashTimer = window.setTimeout(writeHash, 250);
    }
  }
  /** @param {Partial<Camera>} c */
  function setCamera(c) {
    camera = normalizeCamera({ ...camera, ...c });
    cameraChanged();
  }

  /** @type {Map<number, { x: number, y: number }>} */ const pointers = new Map();
  let downAt = /** @type {{ x: number, y: number, t: number } | null} */ (null);
  let moved = false;

  root.addEventListener("pointerdown", (e) => {
    if (e.target !== canvas && e.target !== layer && !(e.target instanceof HTMLElement && e.target.closest(".miu-flat"))) return;
    root.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      downAt = { x: e.clientX, y: e.clientY, t: Date.now() };
      moved = false;
    }
    closePopover();
  });
  root.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (pointers.size === 1) {
      if (downAt && Math.hypot(cur.x - downAt.x, cur.y - downAt.y) > 4) moved = true;
      const d = dragDelta(cur.x - prev.x, cur.y - prev.y, camera, view());
      pointers.set(e.pointerId, cur);
      if (moved) setCamera({ yaw: camera.yaw + d.yaw, pitch: camera.pitch + d.pitch });
    } else if (pointers.size === 2) {
      moved = true;
      const [a, b] = [...pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      pointers.set(e.pointerId, cur);
      const [c, d] = [...pointers.values()];
      const after = Math.hypot(c.x - d.x, c.y - d.y);
      if (before > 0 && after > 0) setCamera({ fov: camera.fov * (before / after) });
    }
  });
  const release = (/** @type {PointerEvent} */ e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (e.type === "pointerup" && pointers.size === 0 && downAt && !moved && opts.onPanoramaClick && scene) {
      const r = root.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const at = screenToYawPitch(x, y, camera, view());
      opts.onPanoramaClick({ yaw: round(at.yaw), pitch: round(at.pitch), x, y });
    }
    if (pointers.size === 0) downAt = null;
  };
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);
  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    setCamera({ fov: camera.fov * Math.exp(e.deltaY * 0.0015) });
  }, { passive: false });
  root.addEventListener("keydown", (e) => {
    if (e.target !== root) {
      if (e.key === "Escape") closePopover();
      return;
    }
    const step = e.shiftKey ? 15 : 5;
    /** @type {Record<string, () => void>} */
    const keys = {
      ArrowLeft: () => setCamera({ yaw: camera.yaw - step }),
      ArrowRight: () => setCamera({ yaw: camera.yaw + step }),
      ArrowUp: () => setCamera({ pitch: camera.pitch + step }),
      ArrowDown: () => setCamera({ pitch: camera.pitch - step }),
      "+": () => setCamera({ fov: camera.fov / 1.15 }),
      "=": () => setCamera({ fov: camera.fov / 1.15 }),
      "-": () => setCamera({ fov: camera.fov * 1.15 }),
      Escape: closePopover,
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });

  // ---------- deep links: #scene=<id>&yaw=&pitch=&fov= ----------
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    const num = (/** @type {string} */ k) => {
      const v = q.get(k);
      return v !== null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
    };
    /** @type {Partial<Camera>} */ const cam = {};
    for (const k of /** @type {const} */ (["yaw", "pitch", "fov"])) {
      const v = num(k);
      if (v !== undefined) cam[k] = v;
    }
    return { sceneId: q.get("scene") || undefined, camera: cam };
  }
  let lastHash = "";
  function writeHash() {
    if (!scene) return;
    const h = `#scene=${encodeURIComponent(scene.id)}&yaw=${round(camera.yaw)}&pitch=${round(camera.pitch)}&fov=${round(camera.fov)}`;
    if (h !== location.hash) {
      lastHash = h;
      history.replaceState(history.state, "", h);
    }
  }
  if (opts.deepLink) {
    window.addEventListener("hashchange", () => {
      if (location.hash === lastHash) return;
      const { sceneId, camera: cam } = readHash();
      if (sceneId && sceneId !== (scene && scene.id) && sceneById(sceneId)) void goto(sceneId, { camera: cam });
      else setCamera(cam);
    });
  }

  function showMessage(/** @type {string} */ text) {
    message.textContent = text;
    message.hidden = !text;
  }

  return {
    root,
    /**
     * Show a tour bundle. Starts at the deep-linked scene (when enabled), `at.sceneId`, the tour's start scene
     * or the first scene.
     * @param {Bundle} b @param {{ sceneId?: string, camera?: Partial<Camera> }} [at]
     */
    async load(b, at = {}) {
      bundle = b;
      const link = opts.deepLink ? readHash() : { sceneId: undefined, camera: {} };
      const id = [link.sceneId, at.sceneId, b.tour.startSceneId, b.scenes[0] && b.scenes[0].id].find((x) => x && sceneById(x));
      if (!id) {
        showMessage("This tour has no scenes yet.");
        return;
      }
      await goto(id, { camera: { ...at.camera, ...link.camera }, fade: false });
    },
    goto,
    /** Replace the data without changing scene (e.g. after editing hotspots). @param {Bundle} b */
    update(b) {
      bundle = b;
      if (scene) scene = sceneById(scene.id) || scene;
      buildMarkers();
    },
    get scene() {
      return scene;
    },
    get camera() {
      return { ...camera };
    },
    get bundle() {
      return bundle;
    },
    get webgl() {
      return webgl;
    },
    setCamera,
    /** Highlight a hotspot marker (editor selection). @param {string} id */
    select(id) {
      selectedId = id;
      for (const [hid, m] of markers) m.classList.toggle("is-selected", hid === id);
    },
    /** @param {number} x @param {number} y CSS pixels relative to the viewer. */
    screenToYawPitch: (x, y) => screenToYawPitch(x, y, camera, view()),
    /** @param {number} yaw @param {number} pitch */
    yawPitchToScreen: (yaw, pitch) => yawPitchToScreen(wrapYaw(yaw), clamp(pitch, -90, 90), camera, view()),
    /** Debug: render now and summarise the canvas pixels ({ width, height, nonBlack, distinct }). */
    pixelStats() {
      if (!gl) return { width: 0, height: 0, nonBlack: 0, distinct: 0 };
      dirty = true;
      draw();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let nonBlack = 0;
      const distinct = new Set();
      for (let i = 0; i < px.length; i += 4 * 7) {
        if (px[i] || px[i + 1] || px[i + 2]) nonBlack++;
        if (distinct.size < 4096) distinct.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
      }
      return { width: w, height: h, nonBlack, distinct: distinct.size };
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      root.replaceChildren();
    },
  };
}

/** @param {number} v */
const round = (v) => Math.round(v * 100) / 100;
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the JSON the tour kit embeds in its pages. */
export function pageData() {
  const node = document.getElementById("miu-tour-data");
  return node ? JSON.parse(node.textContent || "{}") : null;
}

// Auto-start on the public viewer page rendered by the tour kit.
const data = typeof document !== "undefined" ? pageData() : null;
if (data && data.mode === "viewer") {
  const root = /** @type {HTMLElement} */ (document.getElementById("miu-tour"));
  const bundle = /** @type {Bundle} */ (data.bundle);
  const nav = document.getElementById("miu-scenes");
  const mark = () => {
    for (const b of nav ? nav.querySelectorAll("button") : []) b.setAttribute("aria-current", String(b.getAttribute("data-scene-id") === (viewer.scene && viewer.scene.id)));
  };
  const viewer = createViewer(root, { deepLink: true, onSceneChange: mark, panoramaUrl: (s) => s.panoramaUrl || `${data.base}/media/${s.panoramaKey}` });
  if (nav && bundle.scenes.length > 1) {
    for (const s of bundle.scenes) {
      const b = el("button", "miu-scene-button", { type: "button", "data-scene-id": s.id });
      b.textContent = s.title;
      b.addEventListener("click", () => void viewer.goto(s.id));
      nav.append(b);
    }
    nav.hidden = false;
  }
  const ready = viewer.load(bundle);
  // Debug handle for DevTools: miuTour.scene, miuTour.camera, miuTour.goto("<sceneId>").
  /** @type {any} */ (window).miuTour = {
    viewer,
    tour: bundle.tour,
    ready,
    get scene() {
      return viewer.scene && viewer.scene.id;
    },
    get sceneData() {
      return viewer.scene;
    },
    get camera() {
      return viewer.camera;
    },
    goto: (/** @type {string} */ id) => viewer.goto(id),
  };
}
