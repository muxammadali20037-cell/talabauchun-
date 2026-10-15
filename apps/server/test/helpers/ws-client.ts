import WebSocket from "ws";
import type { RoomServerMessage, RoomStateView } from "@talaba/shared";

/** Minimal room client used by tests and the load script. */
export class RoomClient {
  ws!: WebSocket;
  state: RoomStateView | null = null;
  acks = new Map<string, { accepted: boolean; reason?: string; at: number }>();
  errors: string[] = [];
  private waiters: { pred: (s: RoomStateView) => boolean; resolve: (s: RoomStateView) => void }[] = [];
  private ackWaiters = new Map<string, (a: { accepted: boolean; reason?: string }) => void>();
  raw: string[] = [];

  constructor(private readonly url: string, private readonly token: string, private readonly roomId: string) {}

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const s = String(data);
      this.raw.push(s);
      const msg = JSON.parse(s) as RoomServerMessage;
      if (msg.type === "state") {
        this.state = msg.state;
        this.waiters = this.waiters.filter((w) => {
          if (w.pred(msg.state)) {
            w.resolve(msg.state);
            return false;
          }
          return true;
        });
      } else if (msg.type === "ack") {
        this.acks.set(msg.clientMsgId, { accepted: msg.accepted, reason: msg.reason, at: Date.now() });
        this.ackWaiters.get(msg.clientMsgId)?.({ accepted: msg.accepted, reason: msg.reason });
      } else if (msg.type === "error") this.errors.push(msg.code);
    });
    this.ws.send(JSON.stringify({ type: "auth", token: this.token, roomId: this.roomId }));
    return this.waitFor(() => true);
  }

  waitFor(pred: (s: RoomStateView) => boolean, timeoutMs = 10_000): Promise<RoomStateView> {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout; last state " + JSON.stringify(this.state)?.slice(0, 300))), timeoutMs);
      this.waiters.push({ pred, resolve: (s) => (clearTimeout(t), resolve(s)) });
    });
  }

  private seq = 0;
  send(msg: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }> {
    const clientMsgId = `m${++this.seq}`;
    const p = new Promise<{ accepted: boolean; reason?: string }>((resolve) => this.ackWaiters.set(clientMsgId, resolve));
    this.ws.send(JSON.stringify({ ...msg, clientMsgId }));
    return p;
  }

  answer(questionId: string, optionIds: string[]) {
    return this.send({ type: "answer", questionId, optionIds });
  }
  host(action: string) {
    return this.send({ type: "host", action });
  }
  close() {
    this.ws.close();
  }
}
