import { describe, expect, test } from "bun:test";
import {
  yawPitchToVector, vectorToYawPitch, cameraBasis, screenToYawPitch, yawPitchToScreen,
  wrapYaw, clamp, yawPitchToUv, dragDelta,
} from "../../src/tour/client/math.js";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("tour math", () => {
  test("yaw/pitch <-> direction vector round-trips", () => {
    for (let yaw = -179; yaw <= 179; yaw += 17) {
      for (let pitch = -89; pitch <= 89; pitch += 13) {
        const v = yawPitchToVector(yaw, pitch);
        close(Math.hypot(v[0], v[1], v[2]), 1);
        const back = vectorToYawPitch(v);
        close(back.yaw, yaw, 1e-9);
        close(back.pitch, pitch, 1e-9);
      }
    }
  });

  test("conventions: yaw 0 is forward (+z), yaw 90 is right (+x), pitch 90 is up (+y)", () => {
    const f = yawPitchToVector(0, 0);
    close(f[2], 1);
    const r = yawPitchToVector(90, 0);
    close(r[0], 1);
    const u = yawPitchToVector(0, 90);
    close(u[1], 1);
  });

  test("camera basis is orthonormal", () => {
    const { forward, right, up } = cameraBasis(37, -21);
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    close(dot(forward, right), 0);
    close(dot(forward, up), 0);
    close(dot(right, up), 0);
    close(dot(up, up), 1);
  });

  test("screen <-> sphere projection round-trips", () => {
    const cam = { yaw: 30, pitch: 10, fov: 75 };
    const view = { width: 800, height: 600 };
    for (const [x, y] of [[400, 300], [0, 0], [799, 599], [123, 456], [700, 50]] as const) {
      const yp = screenToYawPitch(x, y, cam, view);
      const p = yawPitchToScreen(yp.yaw, yp.pitch, cam, view);
      expect(p.visible).toBe(true);
      close(p.x, x, 1e-6);
      close(p.y, y, 1e-6);
    }
    // centre of the screen looks where the camera looks
    const c = screenToYawPitch(400, 300, cam, view);
    close(c.yaw, 30);
    close(c.pitch, 10);
    // a point to the right of the camera lands right of centre; above lands above
    expect(yawPitchToScreen(40, 10, cam, view).x).toBeGreaterThan(400);
    expect(yawPitchToScreen(30, 20, cam, view).y).toBeLessThan(300);
  });

  test("points behind the camera are not visible", () => {
    const p = yawPitchToScreen(180, 0, { yaw: 0, pitch: 0, fov: 90 }, { width: 100, height: 100 });
    expect(p.visible).toBe(false);
    const edge = yawPitchToScreen(0, 0, { yaw: 0, pitch: 0, fov: 90 }, { width: 100, height: 100 });
    expect(edge).toEqual({ x: 50, y: 50, visible: true });
  });

  test("helpers: wrapYaw, clamp, uv mapping, drag", () => {
    expect(wrapYaw(190)).toBe(-170);
    expect(wrapYaw(-190)).toBe(170);
    expect(wrapYaw(180)).toBe(180);
    expect(wrapYaw(540)).toBe(180);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(yawPitchToUv(0, 0)).toEqual({ u: 0.5, v: 0.5 });
    expect(yawPitchToUv(-180, 90)).toEqual({ u: 0, v: 0 });
    expect(yawPitchToUv(90, -45)).toEqual({ u: 0.75, v: 0.75 });
    // dragging right by the full viewport height turns left by ~fov degrees ("grab the world")
    const d = dragDelta(600, 0, { yaw: 0, pitch: 0, fov: 60 }, { width: 800, height: 600 });
    expect(d.yaw).toBeLessThan(0);
    close(d.yaw, -60, 1e-9);
  });
});
