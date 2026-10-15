// @ts-check
/**
 * Panorama math shared by the tour viewer, the editor (browser, served as /assets/math.js) and the server tests.
 * Plain ES module with JSDoc types and no dependencies, so the browser runs the exact file Bun tests import.
 *
 * Conventions (degrees everywhere):
 *  - yaw   -180..180, 0 = the centre column of the equirectangular image, positive = turn right.
 *  - pitch  -90..90,  0 = horizon, positive = look up.
 *  - fov    vertical field of view.
 *  - World space: +z forward (yaw 0), +x right (yaw 90), +y up.
 *  - Screen: pixels from the top-left corner of the viewport.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {{ yaw: number, pitch: number, fov: number }} Camera */
/** @typedef {{ width: number, height: number }} Viewport */

/** @param {number} v @param {number} min @param {number} max */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Wrap any angle into (-180, 180]. @param {number} yaw */
export function wrapYaw(yaw) {
  const r = ((yaw % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** Unit direction for a yaw/pitch. @param {number} yaw @param {number} pitch @returns {Vec3} */
export function yawPitchToVector(yaw, pitch) {
  const y = yaw * RAD;
  const p = pitch * RAD;
  const c = Math.cos(p);
  return [c * Math.sin(y), Math.sin(p), c * Math.cos(y)];
}

/** Yaw/pitch of a (not necessarily unit) direction. @param {Vec3 | number[]} v */
export function vectorToYawPitch(v) {
  const len = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  return { yaw: Math.atan2(v[0] ?? 0, v[2] ?? 0) * DEG, pitch: Math.asin(clamp((v[1] ?? 0) / len, -1, 1)) * DEG };
}

/** Orthonormal camera axes for a view direction. @param {number} yaw @param {number} pitch */
export function cameraBasis(yaw, pitch) {
  const y = yaw * RAD;
  const p = pitch * RAD;
  /** @type {Vec3} */ const forward = yawPitchToVector(yaw, pitch);
  /** @type {Vec3} */ const right = [Math.cos(y), 0, -Math.sin(y)];
  /** @type {Vec3} */ const up = [-Math.sin(p) * Math.sin(y), Math.cos(p), -Math.sin(p) * Math.cos(y)];
  return { forward, right, up };
}

/** Half-extents of the image plane at distance 1: [tan(fov/2) * aspect, tan(fov/2)]. @param {Camera} cam @param {Viewport} view */
export function planeScale(cam, view) {
  const t = Math.tan((cam.fov * RAD) / 2);
  return [t * (view.width / Math.max(1, view.height)), t];
}

/** The yaw/pitch under a screen pixel. @param {number} x @param {number} y @param {Camera} cam @param {Viewport} view */
export function screenToYawPitch(x, y, cam, view) {
  const { forward: f, right: r, up: u } = cameraBasis(cam.yaw, cam.pitch);
  const [sx, sy] = planeScale(cam, view);
  const nx = ((x / view.width) * 2 - 1) * sx;
  const ny = (1 - (y / view.height) * 2) * sy;
  return vectorToYawPitch([f[0] + r[0] * nx + u[0] * ny, f[1] + r[1] * nx + u[1] * ny, f[2] + r[2] * nx + u[2] * ny]);
}

/**
 * Screen position of a yaw/pitch. `visible` is false when the point is behind the camera (x/y are then
 * meaningless); points in front but outside the viewport are visible with off-screen coordinates.
 * @param {number} yaw @param {number} pitch @param {Camera} cam @param {Viewport} view
 */
export function yawPitchToScreen(yaw, pitch, cam, view) {
  const d = yawPitchToVector(yaw, pitch);
  const { forward: f, right: r, up: u } = cameraBasis(cam.yaw, cam.pitch);
  const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  if (z <= 1e-6) return { x: 0, y: 0, visible: false };
  const [sx, sy] = planeScale(cam, view);
  const nx = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * sx);
  const ny = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * sy);
  return { x: ((nx + 1) / 2) * view.width, y: ((1 - ny) / 2) * view.height, visible: true };
}

/** Texture coordinates (0..1, v down) of a yaw/pitch in an equirectangular image. @param {number} yaw @param {number} pitch */
export function yawPitchToUv(yaw, pitch) {
  return { u: 0.5 + wrapYaw(yaw) / 360 - (wrapYaw(yaw) === 180 && yaw < 0 ? 1 : 0), v: 0.5 - pitch / 180 };
}

/**
 * Camera change for a pointer drag of (dx, dy) pixels: the panorama follows the pointer ("grab the world").
 * @param {number} dx @param {number} dy @param {Camera} cam @param {Viewport} view
 */
export function dragDelta(dx, dy, cam, view) {
  const k = cam.fov / Math.max(1, view.height);
  return { yaw: -dx * k, pitch: dy * k };
}

/** Clamp a camera to valid ranges. @param {Camera} cam @returns {Camera} */
export function normalizeCamera(cam) {
  return { yaw: wrapYaw(cam.yaw), pitch: clamp(cam.pitch, -90, 90), fov: clamp(cam.fov, 30, 120) };
}
