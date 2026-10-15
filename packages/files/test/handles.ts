// Counts this process's open OS handles (file descriptors), where that can be measured: Linux via
// /proc/self/fd, Windows via the process HandleCount. Returns null elsewhere (macOS).
import { readdirSync } from "node:fs";

export function openHandles(): number | null {
  if (process.platform === "linux") {
    try {
      return readdirSync("/proc/self/fd").length;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).HandleCount`]);
    const n = Number(r.stdout.toString().trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
