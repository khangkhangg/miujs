// Types for math.js (plain JS so the browser can load the same file the tests import).
export type Vec3 = [number, number, number];
export interface Camera { yaw: number; pitch: number; fov: number }
export interface Viewport { width: number; height: number }
export declare function clamp(v: number, min: number, max: number): number;
export declare function wrapYaw(yaw: number): number;
export declare function yawPitchToVector(yaw: number, pitch: number): Vec3;
export declare function vectorToYawPitch(v: Vec3 | number[]): { yaw: number; pitch: number };
export declare function cameraBasis(yaw: number, pitch: number): { forward: Vec3; right: Vec3; up: Vec3 };
export declare function planeScale(cam: Camera, view: Viewport): [number, number];
export declare function screenToYawPitch(x: number, y: number, cam: Camera, view: Viewport): { yaw: number; pitch: number };
export declare function yawPitchToScreen(yaw: number, pitch: number, cam: Camera, view: Viewport): { x: number; y: number; visible: boolean };
export declare function yawPitchToUv(yaw: number, pitch: number): { u: number; v: number };
export declare function dragDelta(dx: number, dy: number, cam: Camera, view: Viewport): { yaw: number; pitch: number };
export declare function normalizeCamera(cam: Camera): Camera;
