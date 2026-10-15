// A scriptable stand-in for the browser WebSocket, for client and framework-binding tests.

type Listener = (e: any) => void;

export class FakeWS {
  static all: FakeWS[] = [];
  static last(): FakeWS {
    return FakeWS.all[FakeWS.all.length - 1];
  }

  url: string;
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWS.all.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(m: unknown): void {
    this.sent.push(m);
  }
  close(code = 1000, reason = ""): void {
    this.drop(code, reason);
  }

  // ---- test controls ----
  emit(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  receive(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  /** Open, then deliver welcome + state as a server would. */
  joined(state: unknown, me = { id: "p_1", name: "Ann", role: "player" }): void {
    this.open();
    this.receive({ t: "welcome", me, room: { type: "x", id: "1" }, resumeToken: "tok", resumed: false });
    this.receive({ t: "state", state });
  }
  drop(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}
