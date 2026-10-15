import { encodePng } from "./png.ts";

/**
 * Synthetic equirectangular "rooms" for demos and tests: coloured walls with a yaw/pitch grid, a tiled floor,
 * compass labels and labelled "doors" where link hotspots go. Pure pixel ops, no dependencies.
 */
export interface PanoramaOptions {
  label: string;
  /** Wall colour [r, g, b]. */
  color: [number, number, number];
  /** Doors at these yaw angles (degrees), each with a label such as "TO KITCHEN". */
  doors?: { yaw: number; label: string }[];
  width?: number;
}

// 5x7 bitmap font: 7 rows of 5 bits (MSB = left column).
const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12], "-": [0, 0, 0, 31, 0, 0, 0], ">": [8, 4, 2, 1, 2, 4, 8], " ": [0, 0, 0, 0, 0, 0, 0],
};

export function paintPanorama(opts: PanoramaOptions): { width: number; height: number; rgba: Uint8Array } {
  const width = opts.width ?? 2048;
  const height = width / 2;
  const rgba = new Uint8Array(width * height * 4);
  const [cr, cg, cb] = opts.color;
  const doors = opts.doors ?? [];
  for (let y = 0; y < height; y++) {
    const pitch = 90 - (y / height) * 180;
    for (let x = 0; x < width; x++) {
      const yaw = (x / width) * 360 - 180;
      let r: number, g: number, b: number;
      if (pitch < -30) {
        // floor: checker tiles that shrink toward the nadir
        const d = 1 / Math.tan((-pitch * Math.PI) / 180);
        const tile = (Math.floor(d * Math.sin((yaw * Math.PI) / 180) * 2) + Math.floor(d * Math.cos((yaw * Math.PI) / 180) * 2)) & 1;
        const s = tile ? 0.35 : 0.5;
        r = 200 * s; g = 180 * s; b = 150 * s;
      } else if (pitch > 50) {
        const s = 0.85 + (pitch - 50) / 300;
        r = 240 * s; g = 240 * s; b = 235 * s;
      } else {
        const s = 0.6 + ((pitch + 30) / 80) * 0.4;
        r = cr * s; g = cg * s; b = cb * s;
      }
      for (const d of doors) {
        const dy = Math.abs(((yaw - d.yaw + 540) % 360) - 180);
        if (dy < 12 && pitch > -30 && pitch < 18) {
          r = 90; g = 60; b = 40;
          if (dy > 10.5 || pitch > 16.5) { r = 40; g = 25; b = 15; }
        }
      }
      if (Math.abs(((yaw + 360) % 30) - 15) > 14.8 || Math.abs(((pitch + 180) % 15) - 7.5) > 7.38) {
        r *= 0.75; g *= 0.75; b *= 0.75;
      }
      const i = (y * width + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  const scale = Math.max(2, Math.round(width / 256));
  const text = (s: string, yaw: number, pitch: number, k: number, color: [number, number, number]) =>
    drawText(rgba, width, height, s.toUpperCase(), yaw, pitch, k, color);
  const big = Math.round(scale * 1.5);
  text(opts.label, 0, 36, big, [255, 255, 255]);
  text(opts.label, 180, 36, big, [255, 255, 255]);
  for (const [name, yaw] of [["N", 0], ["E", 90], ["S", 180], ["W", -90]] as const) text(name, yaw, 46.5, scale, [30, 30, 30]);
  for (const d of doors) text(d.label, d.yaw, 22, scale, [255, 240, 120]);
  return { width, height, rgba };
}

function drawText(
  rgba: Uint8Array, width: number, height: number, s: string, yaw: number, pitch: number, k: number,
  color: [number, number, number],
) {
  const cx = Math.round(((yaw + 180) / 360) * width);
  const cy = Math.round(((90 - pitch) / 180) * height);
  const w = s.length * 6 * k - k;
  for (let n = 0; n < s.length; n++) {
    const glyph = FONT[s[n]!] ?? FONT[" "]!;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (!((glyph[row]! >> (4 - col)) & 1)) continue;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const x = (((cx - (w >> 1) + (n * 6 + col) * k + dx) % width) + width) % width;
            const y = cy - ((7 * k) >> 1) + row * k + dy;
            if (y < 0 || y >= height) continue;
            const i = (y * width + x) * 4;
            rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2];
          }
        }
      }
    }
  }
}

/** Paint and encode a sample panorama as PNG bytes. */
export async function makePanorama(opts: PanoramaOptions): Promise<Uint8Array> {
  const { width, height, rgba } = paintPanorama(opts);
  return encodePng(width, height, rgba);
}

/** The demo house: three linked rooms. Door yaws match the hotspots seeded by the demo. */
export const SAMPLE_ROOMS = [
  { file: "lobby.png", label: "Lobby", color: [70, 110, 170], doors: [{ yaw: 60, label: "> Kitchen" }, { yaw: -90, label: "> Garden" }] },
  { file: "kitchen.png", label: "Kitchen", color: [190, 120, 60], doors: [{ yaw: -120, label: "> Lobby" }] },
  { file: "garden.png", label: "Garden", color: [70, 150, 80], doors: [{ yaw: 90, label: "> Lobby" }] },
] satisfies (PanoramaOptions & { file: string })[];
