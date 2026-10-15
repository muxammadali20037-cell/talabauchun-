import type { WebSocket } from "ws";
import { RoomClientMessage, type RoomServerMessage } from "@talaba/shared";
import type { Deps } from "../deps";
import { resolveSession } from "../auth/sessions";
import { hostAction, loadSharedState, pauseIfHostAway, requireMember, revealIfDue, setPresence, submitAnswer, viewFor } from "./service";

type Conn = { ws: WebSocket; userId: string; roomId: string; isHost: boolean; alive: boolean };

/**
 * Realtime fan-out for live rooms. Postgres is the source of truth; every
 * state change is announced with NOTIFY "rooms", so several server instances
 * can each push fresh, per-viewer state to their own sockets.
 */
export class RoomHub {
  private rooms = new Map<string, Set<Conn>>();
  private pendingAnswers = new Map<string, NodeJS.Timeout>();
  private hostTimers = new Map<string, NodeJS.Timeout>();
  private ticker: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private listener: { unlisten: () => Promise<void> } | null = null;

  constructor(private readonly deps: Deps) {}

  async start() {
    this.listener = await this.deps.sql.listen("rooms", (payload) => {
      const [kind, roomId] = payload.split(":");
      if (!roomId || !this.rooms.has(roomId)) return;
      if (kind === "answers") this.scheduleAnswerBroadcast(roomId);
      else void this.broadcast(roomId);
    });
    // Close questions whose server deadline passed (also catches rooms after a restart).
    this.ticker = setInterval(() => void this.sweep(), 250);
    this.heartbeat = setInterval(() => {
      for (const set of this.rooms.values())
        for (const c of set) {
          if (!c.alive) c.ws.terminate();
          else {
            c.alive = false;
            c.ws.ping();
          }
        }
    }, 30_000);
  }

  async stop() {
    if (this.ticker) clearInterval(this.ticker);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const t of this.hostTimers.values()) clearTimeout(t);
    for (const t of this.pendingAnswers.values()) clearTimeout(t);
    await this.listener?.unlisten().catch(() => {});
    for (const set of this.rooms.values()) for (const c of set) c.ws.close(1001, "server shutdown");
  }

  private sweeping = false;
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.deps.sql<{ id: string }[]>`select id from rooms where status = 'running' and phase = 'question' and deadline_at <= clock_timestamp() limit 50`;
      for (const r of due) {
        const changed = await revealIfDue(this.deps.sql, r.id);
        if (changed.length) await this.deps.sql`select pg_notify('rooms', ${`state:${r.id}`})`;
      }
      // optional auto-advance after a short reveal
      const auto = await this.deps.sql<{ id: string; host_id: string }[]>`
        select r.id, r.host_id from rooms r where r.status = 'running' and r.phase = 'reveal' and (r.settings->>'autoAdvance')::boolean is true
          and exists (select 1 from room_events e where e.room_id = r.id and e.id = (select max(id) from room_events where room_id = r.id) and e.at < now() - interval '6 seconds')
        limit 20`;
      for (const r of auto) await hostAction(this.deps, { id: r.host_id }, r.id, "next").catch(() => {});
    } catch {
      /* transient DB errors: next tick retries */
    } finally {
      this.sweeping = false;
    }
  }

  private scheduleAnswerBroadcast(roomId: string) {
    // Coalesce answer bursts: at most one count update per 500 ms per room.
    if (this.pendingAnswers.has(roomId)) return;
    this.pendingAnswers.set(
      roomId,
      setTimeout(() => {
        this.pendingAnswers.delete(roomId);
        void this.broadcast(roomId);
      }, 500),
    );
  }

  async broadcast(roomId: string) {
    const set = this.rooms.get(roomId);
    if (!set?.size) return;
    const shared = await loadSharedState(this.deps.sql, roomId);
    const now = Date.now();
    for (const c of set) this.send(c.ws, { type: "state", state: viewFor(shared, c.userId, this.deps.cfg.SIGNING_SECRET, now) });
  }

  private send(ws: WebSocket, msg: RoomServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Socket lifecycle: first message must be {type:"auth", token, roomId} within 10 s. */
  handle(ws: WebSocket) {
    let conn: Conn | null = null;
    const authTimer = setTimeout(() => ws.close(4001, "auth timeout"), 10_000);
    ws.on("pong", () => {
      if (conn) conn.alive = true;
    });
    ws.on("message", async (raw) => {
      let msg: RoomClientMessage;
      try {
        msg = RoomClientMessage.parse(JSON.parse(String(raw)));
      } catch {
        this.send(ws, { type: "error", code: "bad_message", message: "invalid message" });
        return;
      }
      try {
        if (msg.type === "auth") {
          const user = await resolveSession(this.deps.sql, msg.token);
          await requireMember(this.deps.sql, msg.roomId, user.id);
          clearTimeout(authTimer);
          const shared = await loadSharedState(this.deps.sql, msg.roomId);
          const isHost = shared.room.host_id === user.id || shared.room.co_host_id === user.id;
          conn = { ws, userId: user.id, roomId: msg.roomId, isHost, alive: true };
          if (!this.rooms.has(msg.roomId)) this.rooms.set(msg.roomId, new Set());
          this.rooms.get(msg.roomId)!.add(conn);
          await setPresence(this.deps.sql, msg.roomId, user.id, true);
          if (isHost) {
            clearTimeout(this.hostTimers.get(msg.roomId));
            this.hostTimers.delete(msg.roomId);
          }
          await this.deps.sql`select pg_notify('rooms', ${`state:${msg.roomId}`})`;
          // immediate snapshot for this socket (reconnect restores question, own answer and score)
          this.send(ws, { type: "state", state: viewFor(await loadSharedState(this.deps.sql, msg.roomId), user.id, this.deps.cfg.SIGNING_SECRET) });
          return;
        }
        if (!conn) {
          this.send(ws, { type: "error", code: "unauthorized", message: "auth first" });
          return;
        }
        if (msg.type === "ping") {
          this.send(ws, { type: "pong", t: msg.t, serverNow: Date.now() });
        } else if (msg.type === "sync") {
          this.send(ws, { type: "state", state: viewFor(await loadSharedState(this.deps.sql, conn.roomId), conn.userId, this.deps.cfg.SIGNING_SECRET) });
        } else if (msg.type === "answer") {
          const r = await submitAnswer(this.deps, { id: conn.userId }, conn.roomId, msg.questionId, msg.optionIds);
          this.send(ws, { type: "ack", clientMsgId: msg.clientMsgId, accepted: r.accepted, ...(r.accepted ? {} : { reason: r.reason }) });
        } else if (msg.type === "host") {
          const r = await hostAction(this.deps, { id: conn.userId }, conn.roomId, msg.action);
          this.send(ws, { type: "ack", clientMsgId: msg.clientMsgId, accepted: r.changed, ...(r.changed ? {} : { reason: "no_change" }) });
        }
      } catch (e) {
        const code = (e as { code?: string }).code ?? "error";
        if ("clientMsgId" in msg && msg.clientMsgId) this.send(ws, { type: "ack", clientMsgId: msg.clientMsgId, accepted: false, reason: code });
        else this.send(ws, { type: "error", code, message: code });
        if (!conn && msg.type === "auth") ws.close(4003, code);
      }
    });
    ws.on("close", async () => {
      clearTimeout(authTimer);
      if (!conn) return;
      const c = conn;
      this.rooms.get(c.roomId)?.delete(c);
      if (!this.rooms.get(c.roomId)?.size) this.rooms.delete(c.roomId);
      const stillConnected = [...(this.rooms.get(c.roomId) ?? [])].some((x) => x.userId === c.userId);
      if (stillConnected) return;
      await setPresence(this.deps.sql, c.roomId, c.userId, false).catch(() => {});
      await this.deps.sql`select pg_notify('rooms', ${`state:${c.roomId}`})`.catch(() => {});
      if (c.isHost) {
        const [room] = await this.deps.sql<{ settings: { hostGraceSec?: number } }[]>`select settings from rooms where id = ${c.roomId}`.catch(() => []);
        const grace = (room?.settings?.hostGraceSec ?? 20) * 1000;
        this.hostTimers.set(c.roomId, setTimeout(() => void pauseIfHostAway(this.deps, c.roomId).catch(() => {}), grace));
      }
    });
  }
}
