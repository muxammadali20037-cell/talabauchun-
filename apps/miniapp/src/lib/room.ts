import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomServerMessage, RoomStateView } from "@talaba/shared";
import { getToken } from "./api";

export type Pending = { questionId: string; optionIds: string[]; status: "sending" | "accepted" | "rejected" | "unconfirmed"; reason?: string };

/**
 * Live room socket: authenticates with the session token in the first message
 * (never in the URL), reconnects with backoff and restores state from the
 * server. An answer is shown as accepted only after the server's ack.
 */
export function useRoomSocket(roomId: string) {
  const [state, setState] = useState<RoomStateView | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [offset, setOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const acks = useRef(new Map<string, (a: { accepted: boolean; reason?: string }) => void>());
  const seq = useRef(0);
  const retry = useRef(0);
  const closed = useRef(false);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/rooms`);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: getToken(), roomId }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as RoomServerMessage;
      if (msg.type === "state") {
        setConnected(true);
        setError(null);
        retry.current = 0;
        setOffset(msg.state.serverNow - Date.now());
        setState(msg.state);
        setPending((p) => {
          if (!p) return p;
          if (msg.state.myAnswer?.questionId === p.questionId) return { ...p, status: "accepted" };
          if (msg.state.question?.id !== p.questionId) return null;
          return p;
        });
      } else if (msg.type === "ack") {
        acks.current.get(msg.clientMsgId)?.({ accepted: msg.accepted, reason: msg.reason });
        acks.current.delete(msg.clientMsgId);
      } else if (msg.type === "error") {
        setError(msg.code);
      }
    };
    ws.onclose = (ev) => {
      setConnected(false);
      setPending((p) => (p && p.status === "sending" ? { ...p, status: "unconfirmed" } : p));
      if (closed.current || ev.code === 4003) {
        if (ev.code === 4003) setError(ev.reason || "forbidden");
        return;
      }
      const delay = Math.min(10_000, 500 * 2 ** retry.current++);
      setTimeout(() => !closed.current && connect(), delay);
    };
  }, [roomId]);

  useEffect(() => {
    closed.current = false;
    connect();
    const ping = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "ping", t: Date.now() }));
    }, 25_000);
    const onOnline = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) connect();
    };
    window.addEventListener("online", onOnline);
    return () => {
      closed.current = true;
      clearInterval(ping);
      window.removeEventListener("online", onOnline);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const clientMsgId = `c${++seq.current}`;
    return new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return resolve({ accepted: false, reason: "offline" });
      acks.current.set(clientMsgId, resolve);
      wsRef.current.send(JSON.stringify({ ...msg, clientMsgId }));
      setTimeout(() => {
        if (acks.current.has(clientMsgId)) {
          acks.current.delete(clientMsgId);
          resolve({ accepted: false, reason: "timeout" });
        }
      }, 10_000);
    });
  }, []);

  const answer = useCallback(
    async (questionId: string, optionIds: string[]) => {
      setPending({ questionId, optionIds, status: "sending" });
      const r = await send({ type: "answer", questionId, optionIds });
      setPending((p) =>
        p && p.questionId === questionId
          ? { ...p, status: r.accepted || r.reason === "already_answered" ? "accepted" : r.reason === "offline" || r.reason === "timeout" ? "unconfirmed" : "rejected", reason: r.reason }
          : p,
      );
    },
    [send],
  );
  const host = useCallback((action: string) => send({ type: "host", action }), [send]);
  return { state, connected, error, pending, answer, host, serverNow: () => Date.now() + offset };
}
