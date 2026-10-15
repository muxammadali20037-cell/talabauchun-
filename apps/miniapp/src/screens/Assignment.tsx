import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { shareToTelegram, tg } from "../lib/telegram";
import { Badge, Banner, ErrorState, Loading, Screen, toast } from "../components/ui";

type View = {
  roomId: string; title: string; status: "open" | "closed"; dueAt: string | null; total: number; isHost: boolean;
  rules: { pointsCorrect: number; showLeaderboard: boolean };
  me: { attemptId: string; status: string; score: number | null; maxScore: number; answered: number } | null;
  progress: { userId: string; name: string; state: "not_started" | "started" | "finished"; score: number; answered: number }[] | null;
  leaderboard: { rank: number; name: string; score: number; isMe: boolean }[] | null;
};
type Invite = { inviteLink: string | null; inviteExpiresAt: string };

/** Self-paced assignment: everyone takes the quiz once, before the deadline; results and ranking open afterwards. */
export function Assignment() {
  const { id } = useParams();
  const t = useT();
  const navigate = useNavigate();
  const v = useQuery({ queryKey: ["assignment", id], queryFn: () => api.get<View>(`/api/rooms/${id}/assignment`), refetchInterval: 20_000, staleTime: 0 });
  const [invite, setInvite] = useState<Invite | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`room.invite.${id}`) ?? "null") as Invite | null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (v.isLoading) return <Screen title={t("assignment.title")}><Loading /></Screen>;
  if (v.isError) return <Screen title={t("assignment.title")}><ErrorState error={v.error} onRetry={() => v.refetch()} /></Screen>;
  const a = v.data!;
  const due = a.dueAt ? new Date(a.dueAt).toLocaleString() : "—";
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ attemptId: string }>(`/api/rooms/${id}/assignment/start`);
      navigate(`/attempt/${r.attemptId}`);
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const closeNow = async () => {
    const ok = await new Promise<boolean>((res) => (tg()?.showConfirm ? tg()!.showConfirm!(t("assignment.closeConfirm"), res) : res(window.confirm(t("assignment.closeConfirm")))));
    if (!ok) return;
    try {
      await api.post(`/api/rooms/${id}/host`, { action: "finish" });
      await v.refetch();
    } catch (e) {
      toast(errorMessage(e, t));
    }
  };
  const newLink = async () => {
    try {
      const r = await api.post<Invite>(`/api/rooms/${id}/invite`);
      sessionStorage.setItem(`room.invite.${id}`, JSON.stringify(r));
      setInvite(r);
    } catch (e) {
      toast(errorMessage(e, t));
    }
  };
  return (
    <Screen title={a.title}>
      <div className="stack-l">
        <section className="card stack">
          <div className="row between wrap">
            <Badge kind={a.status === "open" ? "success" : "neutral"}>{a.status === "open" ? t("assignment.open") : t("assignment.closed")}</Badge>
            <span className="caption">{t("assignment.due", { date: due })}</span>
          </div>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t("assignment.ruleOnce", { n: a.total })}</li>
            <li>{t("room.rules", { points: a.rules.pointsCorrect })}</li>
            <li>{t("assignment.ruleHidden")}</li>
            <li>{a.rules.showLeaderboard ? t("assignment.ruleBoard") : t("room.leaderboardHidden")}</li>
          </ul>
        </section>

        {!a.isHost && (
          <section className="stack">
            {a.status === "open" && (!a.me || a.me.status === "active") && (
              <button className="btn btn-primary btn-block" disabled={busy} onClick={start}>{a.me ? t("assignment.continue", { n: a.me.answered, total: a.total }) : t("assignment.start")}</button>
            )}
            {a.me?.status === "finished" && a.status === "open" && <Banner kind="success">{t("assignment.submittedWait")}</Banner>}
            {a.status === "closed" && a.me && (
              <div className="card stack" style={{ textAlign: "center" }}>
                <h2>{t("room.myScore", { points: a.me.score ?? 0 })}</h2>
                <Link className="btn btn-secondary" to={`/attempt/${a.me.attemptId}`}>{t("assignment.seeMyAnswers")}</Link>
              </div>
            )}
            {a.status === "closed" && !a.me && <Banner kind="info">{t("assignment.missed")}</Banner>}
          </section>
        )}

        {a.isHost && a.status === "open" && (
          <section className="card stack">
            <h3>{t("room.inviteTitle")}</h3>
            {invite?.inviteLink ? (
              <div className="row wrap">
                <button className="btn btn-primary" onClick={() => shareToTelegram(invite.inviteLink!, t("assignment.shareText", { title: a.title, date: due }))}>{t("common.share")}</button>
                <button className="btn btn-secondary" onClick={async () => { await navigator.clipboard?.writeText(invite.inviteLink!).catch(() => {}); toast(t("common.copied")); }}>{t("common.copy")}</button>
              </div>
            ) : <button className="btn btn-secondary" onClick={newLink}>{t("room.newInvite")}</button>}
            <button className="btn btn-ghost" onClick={closeNow}>{t("assignment.closeNow")}</button>
          </section>
        )}

        {a.progress && (
          <section className="stack">
            <h2 className="section-title">{t("assignment.progress", { done: a.progress.filter((p) => p.state === "finished").length, total: a.progress.length })}</h2>
            <div className="list">
              {a.progress.map((p) => (
                <div key={p.userId} className="list-item">
                  <span className="grow break">{p.name}</span>
                  <span className="meta">{p.answered}/{a.total}</span>
                  <Badge kind={p.state === "finished" ? "success" : p.state === "started" ? "warn" : "neutral"}>{t(`assignment.state_${p.state}`)}</Badge>
                  {a.status === "closed" && <strong>{p.score}</strong>}
                </div>
              ))}
            </div>
          </section>
        )}

        {a.leaderboard && (
          <section className="card stack">
            <h2>{t("room.leaderboard")}</h2>
            {a.leaderboard.map((r) => (
              <div key={r.rank} className="lb-row" style={r.isMe ? { fontWeight: 700 } : undefined}>
                <span className="lb-rank">{r.rank}</span>
                <span className="grow break">{r.name}</span>
                <strong>{r.score}</strong>
              </div>
            ))}
          </section>
        )}
        {err && <Banner kind="danger">{err}</Banner>}
      </div>
    </Screen>
  );
}
