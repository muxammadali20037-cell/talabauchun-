import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Badge, Empty, ErrorState, Loading, Screen } from "../components/ui";

type RoomItem = { id: string; title: string; status: string; role: string; created_at: string; participants: number; mode: string; dueAt: string | null };
type RunItem = { id: string; status: string; chat_title: string | null; anonymous: boolean; created_at: string; questions: number; title: string };
type WsItem = { id: string; name: string; role: string; members: number };

export function Groups() {
  const t = useT();
  const rooms = useQuery({ queryKey: ["my-rooms"], queryFn: () => api.get<{ items: RoomItem[] }>("/api/rooms?limit=20") });
  const runs = useQuery({ queryKey: ["my-group-runs"], queryFn: () => api.get<{ items: RunItem[] }>("/api/group-runs?limit=20") });
  const ws = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<{ items: WsItem[] }>("/api/workspaces") });
  return (
    <Screen title={t("group.title")} back={false}>
      <div className="stack-l">
        <section className="stack">
          <div className="row between">
            <h2 className="section-title">{t("group.workspaces")}</h2>
            <Link className="btn btn-ghost btn-sm" to="/workspaces/new">+ {t("group.newWorkspace")}</Link>
          </div>
          {ws.isLoading ? <Loading lines={1} /> : ws.isError ? <ErrorState error={ws.error} onRetry={() => ws.refetch()} /> : !ws.data!.items.filter((w) => w.role).length ? (
            <p className="caption">{t("group.noWorkspaces")}</p>
          ) : (
            <div className="list">
              {ws.data!.items.map((w) => (
                <Link key={w.id} to={`/workspaces/${w.id}`} className="list-item">
                  <span aria-hidden>👥</span>
                  <span className="grow break">{w.name}</span>
                  <Badge kind="neutral">{t(w.role === "owner" ? "group.roleOwner" : w.role === "editor" ? "group.roleEditor" : "group.roleViewer")}</Badge>
                  <span className="meta">{w.members}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section className="stack">
          <h2 className="section-title">{t("room.title")}</h2>
          {rooms.isLoading ? <Loading lines={2} /> : rooms.isError ? <ErrorState error={rooms.error} onRetry={() => rooms.refetch()} /> : !rooms.data!.items.length ? (
            <Empty icon="⚡" text={t("group.noRooms")} action={<Link className="btn btn-secondary" to="/quizzes">{t("create.myQuizzes")}</Link>} />
          ) : (
            <div className="list">
              {rooms.data!.items.map((r) => (
                <Link key={r.id} to={r.mode === "async" ? `/assignment/${r.id}` : `/room/${r.id}`} className="list-item">
                  <span aria-hidden>{r.mode === "async" ? "📅" : r.role === "host" ? "🎤" : "🎯"}</span>
                  <div className="grow">
                    <div className="break">{r.title}</div>
                    <div className="meta">{new Date(r.created_at).toLocaleString()} · {t("room.participants", { n: r.participants })}</div>
                  </div>
                  <Badge kind={r.status === "finished" ? "neutral" : r.status === "running" ? "success" : "primary"}>{t(`roomStatus.${r.status}` as never)}</Badge>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section className="stack">
          <h2 className="section-title">{t("quiz.shareToGroup")}</h2>
          {runs.isLoading ? <Loading lines={1} /> : !runs.data?.items.length ? (
            <p className="caption">{t("group.howTo")}</p>
          ) : (
            <div className="list">
              {runs.data.items.map((r) => (
                <div key={r.id} className="list-item">
                  <span aria-hidden>💬</span>
                  <div className="grow">
                    <div className="break">{r.title}</div>
                    <div className="meta">{r.chat_title ?? "—"} · {r.anonymous ? t("group.anonymous") : t("group.notAnonymous")}</div>
                  </div>
                  <Badge kind="neutral">{t(`runStatus.${r.status}` as never)}</Badge>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Screen>
  );
}
