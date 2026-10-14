import { describe, expect, test } from "bun:test";
import { FrameParser, WsProtocolError, acceptKey, encodeFrame, OP } from "../../src/adapters/node-ws.ts";

const enc = new TextEncoder();
const MASK = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]);

/** Build a client frame by hand (masked unless mask === null). */
function frame(opcode: number, payload: Uint8Array | string, o: { fin?: boolean; mask?: Uint8Array | null; rsv?: number } = {}) {
  const data = typeof payload === "string" ? enc.encode(payload) : payload;
  const mask = o.mask === undefined ? MASK : o.mask;
  const len = data.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const out = new Uint8Array(2 + ext + (mask ? 4 : 0) + len);
  out[0] = ((o.fin ?? true) ? 0x80 : 0) | ((o.rsv ?? 0) << 4) | opcode;
  out[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  const dv = new DataView(out.buffer);
  if (ext === 2) dv.setUint16(2, len);
  if (ext === 8) dv.setBigUint64(2, BigInt(len));
  let off = 2 + ext;
  if (mask) {
    out.set(mask, off);
    off += 4;
  }
  for (let i = 0; i < len; i++) out[off + i] = mask ? data[i]! ^ mask[i & 3]! : data[i]!;
  return out;
}

const parser = (o: { maxPayload?: number; requireMask?: boolean } = {}) => new FrameParser({ maxPayload: o.maxPayload ?? 1 << 20, requireMask: o.requireMask ?? true });

function codeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof WsProtocolError) return e.code;
    throw e;
  }
  return undefined;
}

describe("RFC 6455 frame parser", () => {
  test("Sec-WebSocket-Accept matches the RFC example", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("unmasks a masked text frame (RFC 5.7 'Hello')", () => {
    const bytes = new Uint8Array([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    expect(parser().push(bytes)).toEqual([{ type: "message", data: "Hello" }]);
  });

  test("binary frames come out as bytes", () => {
    expect(parser().push(frame(OP.BINARY, new Uint8Array([1, 2, 3])))).toEqual([{ type: "message", data: new Uint8Array([1, 2, 3]) }]);
  });

  test("handles frames split at every byte boundary and several frames in one chunk", () => {
    const bytes = new Uint8Array([...frame(OP.TEXT, "ab"), ...frame(OP.TEXT, "cd")]);
    const p = parser();
    const out = [];
    for (const b of bytes) out.push(...p.push(new Uint8Array([b])));
    expect(out).toEqual([{ type: "message", data: "ab" }, { type: "message", data: "cd" }]);
    expect(parser().push(bytes)).toEqual(out);
  });

  test("16-bit extended length (126)", () => {
    const text = "x".repeat(300);
    const f = frame(OP.TEXT, text);
    expect(f[1]! & 0x7f).toBe(126);
    expect(parser().push(f)).toEqual([{ type: "message", data: text }]);
  });

  test("64-bit extended length (127)", () => {
    const data = new Uint8Array(70_000).map((_, i) => i & 0xff);
    const f = frame(OP.BINARY, data);
    expect(f[1]! & 0x7f).toBe(127);
    const p = parser();
    const out = [...p.push(f.subarray(0, 5000)), ...p.push(f.subarray(5000))];
    expect(out).toEqual([{ type: "message", data }]);
  });

  test("reassembles fragmented messages with control frames interleaved", () => {
    const bytes = new Uint8Array([
      ...frame(OP.TEXT, "Hel", { fin: false }),
      ...frame(OP.PING, "p"),
      ...frame(OP.CONT, "lo ", { fin: false }),
      ...frame(OP.CONT, "wörld"),
    ]);
    expect(parser().push(bytes)).toEqual([
      { type: "ping", data: enc.encode("p") },
      { type: "message", data: "Hello wörld" },
    ]);
  });

  test("UTF-8 split across fragments is decoded once the message is complete", () => {
    const b = enc.encode("é");
    const bytes = new Uint8Array([...frame(OP.TEXT, b.subarray(0, 1), { fin: false }), ...frame(OP.CONT, b.subarray(1))]);
    expect(parser().push(bytes)).toEqual([{ type: "message", data: "é" }]);
  });

  test("ping, pong and close frames", () => {
    const closePayload = new Uint8Array([0x0f, 0xa0, ...enc.encode("bye")]); // 4000
    expect(parser().push(new Uint8Array([...frame(OP.PING, "a"), ...frame(OP.PONG, "b"), ...frame(OP.CLOSE, closePayload)]))).toEqual([
      { type: "ping", data: enc.encode("a") },
      { type: "pong", data: enc.encode("b") },
      { type: "close", code: 4000, reason: "bye" },
    ]);
    expect(parser().push(frame(OP.CLOSE, new Uint8Array()))).toEqual([{ type: "close", code: 1005, reason: "" }]);
  });

  test("rejects unmasked client frames (1002)", () => {
    expect(codeOf(() => parser().push(frame(OP.TEXT, "hi", { mask: null })))).toBe(1002);
    // ...but a client-side parser accepts them.
    expect(parser({ requireMask: false }).push(frame(OP.TEXT, "hi", { mask: null }))).toEqual([{ type: "message", data: "hi" }]);
  });

  test("rejects protocol violations", () => {
    expect(codeOf(() => parser().push(frame(OP.TEXT, "x", { rsv: 4 })))).toBe(1002); // RSV1 without extension
    expect(codeOf(() => parser().push(frame(3, "x")))).toBe(1002); // reserved opcode
    expect(codeOf(() => parser().push(frame(OP.PING, "x", { fin: false })))).toBe(1002); // fragmented control
    expect(codeOf(() => parser().push(frame(OP.PING, "x".repeat(126))))).toBe(1002); // control > 125
    expect(codeOf(() => parser().push(frame(OP.CONT, "x")))).toBe(1002); // continuation without start
    expect(codeOf(() => parser().push(new Uint8Array([...frame(OP.TEXT, "a", { fin: false }), ...frame(OP.TEXT, "b")])))).toBe(1002);
    expect(codeOf(() => parser().push(frame(OP.CLOSE, new Uint8Array([3]))))).toBe(1002); // 1-byte close payload
    expect(codeOf(() => parser().push(frame(OP.CLOSE, new Uint8Array([0x03, 0xec]))))).toBe(1002); // 1004 is reserved
  });

  test("rejects invalid UTF-8 in text frames and close reasons (1007)", () => {
    expect(codeOf(() => parser().push(frame(OP.TEXT, new Uint8Array([0xff, 0xfe]))))).toBe(1007);
    expect(codeOf(() => parser().push(frame(OP.CLOSE, new Uint8Array([0x03, 0xe8, 0xff]))))).toBe(1007);
  });

  test("enforces maxPayload from the header, before buffering (1009)", () => {
    const p = parser({ maxPayload: 100 });
    // Only the header of a 1 MB frame: rejected without waiting for the body.
    const header = frame(OP.BINARY, new Uint8Array(1 << 20)).subarray(0, 14);
    expect(codeOf(() => p.push(header))).toBe(1009);
    // A 64-bit length beyond 2^53 is rejected too.
    const huge = new Uint8Array([0x82, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
    expect(codeOf(() => parser().push(huge))).toBe(1009);
  });

  test("maxPayload counts the whole fragmented message", () => {
    const p = parser({ maxPayload: 10 });
    expect(p.push(frame(OP.TEXT, "123456", { fin: false }))).toEqual([]);
    expect(codeOf(() => p.push(frame(OP.CONT, "789012")))).toBe(1009);
  });

  test("encodeFrame produces unmasked server frames with the right length encoding", () => {
    const client = parser({ requireMask: false });
    for (const n of [0, 5, 125, 126, 65535, 65536]) {
      const data = new Uint8Array(n).fill(7);
      const f = encodeFrame(OP.BINARY, data);
      expect(f[1]! & 0x80).toBe(0);
      expect(client.push(f)).toEqual([{ type: "message", data }]);
    }
    expect(client.push(encodeFrame(OP.TEXT, "héllo"))).toEqual([{ type: "message", data: "héllo" }]);
    // Masked encoding (for clients/tests) round-trips through the server parser.
    expect(parser().push(encodeFrame(OP.TEXT, "masked", { mask: MASK }))).toEqual([{ type: "message", data: "masked" }]);
  });
});
