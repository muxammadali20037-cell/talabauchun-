import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RoomStateView } from "@talaba/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useRoomSocket } from "../lib/room";
import { haptic, shareToTelegram } from "../lib/telegram";
import { Badge, Banner, Loading, Screen, toast } from "../components/ui";
import { ReportButton } from "../components/ReportButton";

type Invite = { inviteLink: string | null; inviteToken: string; inviteExpiresAt: string; code?: string };

export function Room() {
  const { id } = useParams();
  const t = useT();
  const { state, connected, error, pending, answer, host, serverNow } = useRoomSocket(id!);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, []);
  if (error && !state) return <Screen title={t("room.title")}><Banner kind="danger">{error === "not_found" ? t("room.expiredInvite") : t("common.error")}</Banner></Screen>;
  if (!state) return <Screen title={t("room.title")}><Loading /></Screen>;
  const s = state;
  const remainingMs = s.deadline ? Math.max(0, s.deadline - serverNow()) : s.pausedRemainingMs ?? 0;
  void now;
  return (
    <Screen title={s.title}>
      <div className="stack-l">
        {!connected && <Banner kind="warn">{t("room.reconnecting")}</Banner>}
        {s.status === "paused" && <Banner kind="warn">{s.hostConnected ? t("room.paused") : t("room.hostLeft")}</Banner>}
        {s.status === "lobby" && <Lobby s={s} roomId={id!} />}
        {(s.status === "running" || s.status === "paused") && s.question && (
          <QuestionView s={s} remainingMs={remainingMs} pending={pending} onAnswer={(ids) => { haptic("light"); void answer(s.question!.id, ids); }} />
        )}
        {s.status === "finished" && <Finished s={s} roomId={id!} />}
        {s.isHost && s.status !== "finished" && <HostControls s={s} act={async (a) => {
          const r = await host(a);
          if (!r.accepted && r.reason !== "no_change") toast(t("common.error"));
        }} />}
      </div>
    </Screen>
  );
}

function Rules({ s }: { s: RoomStateView }) {
  const t = useT();
  return (
    <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
      <li>{t("room.rules", { points: s.rules.pointsCorrect })}</li>
      <li>{s.rules.speedBonusMax ? t("room.speedBonusRule", { max: s.rules.speedBonusMax }) : t("room.noSpeedBonus")}</li>
      <li>{s.rules.showLeaderboard ? t("room.leaderboardVisible") : t("room.leaderboardHidden")}</li>
      <li>{t("room.timeRule", { sec: s.rules.timePerQuestionSec })}</li>
      {s.rules.teamScoring === "average" && <li>{t("room.teamRule")}</li>}
    </ul>
  );
}

/** Quiz Battle standings: team score is the average of its members' points, so team size does not decide the winner. */
function TeamBoard({ s }: { s: RoomStateView }) {
  const t = useT();
  if (!s.teams) return null;
  const sorted = [...s.teams].sort((a, b) => b.averagePoints - a.averagePoints);
  const mine = s.teams.find((x) => x.id === s.myTeamId);
  return (
    <section className="card stack" aria-label={t("room.teams")}>
      <div className="row between wrap">
        <h3>{t("room.teams")}</h3>
        {mine && <span className="badge badge-neutral"><span className="team-dot" style={{ background: mine.color }} aria-hidden /> {t("room.yourTeam", { name: mine.name })}</span>}
      </div>
      {sorted.map((team, i) => (
        <div key={team.id} className="lb-row">
          <span className="lb-rank">{i > 0 && sorted[i - 1]!.averagePoints === team.averagePoints ? "=" : i + 1}</span>
          <span className="team-dot" style={{ background: team.color }} aria-hidden />
          <span className="grow">{t("room.teamName", { name: team.name })} · <span className="caption">{t("room.membersN", { n: team.members })}</span></span>
          <strong>{team.averagePoints}</strong>
        </div>
      ))}
      <p className="caption">{t("room.teamRule")}</p>
    </section>
  );
}

function Lobby({ s, roomId }: { s: RoomStateView; roomId: string }) {
  const t = useT();
  const [invite, setInvite] = useState<Invite | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`room.invite.${roomId}`) ?? "null") as Invite | null;
    } catch {
      return null;
    }
  });
  const others = s.participants.filter((p) => !p.isHost);
  const newLink = async () => {
    const r = await api.post<Invite>(`/api/rooms/${roomId}/invite`);
    sessionStorage.setItem(`room.invite.${roomId}`, JSON.stringify(r));
    setInvite(r);
  };
  return (
    <div className="stack-l">
      {s.isHost ? (
        <section className="card stack">
          <h2>{t("room.inviteTitle")}</h2>
          {s.code && <div className="code-box" aria-label={t("room.code")}>{s.code}</div>}
          {invite?.inviteLink ? (
            <>
              <div className="row wrap">
                <button className="btn btn-primary" onClick={() => shareToTelegram(invite.inviteLink!, t("room.shareText", { title: s.title }))}>{t("common.share")}</button>
                <button className="btn btn-secondary" onClick={async () => { await navigator.clipboard?.writeText(invite.inviteLink!); toast(t("common.copied")); }}>{t("common.copy")}</button>
                <button className="btn btn-ghost" onClick={async () => { await api.del(`/api/rooms/${roomId}/invite`); sessionStorage.removeItem(`room.invite.${roomId}`); setInvite(null); toast(t("common.done")); }}>{t("room.revokeInvite")}</button>
              </div>
              <p className="caption">{t("room.inviteExpires", { time: new Date(invite.inviteExpiresAt).toLocaleString() })}</p>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={newLink}>{t("room.newInvite")}</button>
          )}
        </section>
      ) : (
        <div className="state card flat"><div className="spinner" aria-hidden /><p>{t("room.waitingHost")}</p></div>
      )}
      <section className="card stack">
        <h3>{t("room.rulesTitle")}</h3>
        <Rules s={s} />
      </section>
      <TeamBoard s={s} />
      <section className="stack">
        <h2 className="section-title">{t("room.participants", { n: others.length })}</h2>
        <div className="row wrap">
          {others.map((p) => (
            <span key={p.userId} className="badge badge-neutral" style={{ opacity: p.connected ? 1 : 0.6 }}>{p.connected ? "●" : "○"} {p.name}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

function QuestionView({ s, remainingMs, pending, onAnswer }: { s: RoomStateView; remainingMs: number; pending: ReturnType<typeof useRoomSocket>["pending"]; onAnswer: (ids: string[]) => void }) {
  const t = useT();
  const q = s.question!;
  const reveal = s.phase === "reveal" ? s.reveal : null;
  const mine = s.myAnswer?.questionId === q.id ? s.myAnswer.optionIds : pending?.questionId === q.id ? pending.optionIds : [];
  const [multi, setMulti] = useState<string[]>([]);
  const locked = !!reveal || s.status !== "running" || s.isHost || mine.length > 0;
  const total = s.rules.timePerQuestionSec * 1000;
  const sec = Math.ceil(remainingMs / 1000);
  return (
    <div className="stack">
      <div className="row between">
        <span className="caption">{t("practice.question", { i: q.index + 1, n: q.total })}</span>
        {!reveal && <span className="timer" aria-live="off" aria-label={`${sec}s`}>⏱ {sec}</span>}
        {s.isHost && <Badge kind="primary">{t("room.answered", { n: s.answeredCount, total: s.participants.filter((p) => !p.isHost).length })}</Badge>}
      </div>
      {!reveal && <div className="timer-bar" aria-hidden><span style={{ width: `${(remainingMs / total) * 100}%` }} /></div>}
      <h2 className="break" style={{ fontSize: 19, lineHeight: 1.4 }}>{q.text}</h2>
      <div className="stack" role={q.multiple ? "group" : "radiogroup"}>
        {q.options.map((o, i) => {
          const chosen = mine.includes(o.id) || multi.includes(o.id);
          const cls = reveal ? (reveal.correctOptionIds.includes(o.id) ? " correct" : mine.includes(o.id) ? " wrong" : "") : "";
          return (
            <button key={o.id} className={`choice${cls}`} aria-pressed={chosen} disabled={locked} onClick={() => (q.multiple ? setMulti(chosen ? multi.filter((x) => x !== o.id) : [...multi, o.id]) : onAnswer([o.id]))}>
              <span className="letter" aria-hidden>{String.fromCharCode(65 + i)}</span>
              <span className="grow break">{o.text}</span>
              {reveal && <span className="mark">{reveal.counts[o.id] ?? 0}</span>}
            </button>
          );
        })}
      </div>
      {q.multiple && !locked && <button className="btn btn-primary" disabled={!multi.length} onClick={() => onAnswer(multi)}>{t("practice.check")}</button>}
      {!s.isHost && !reveal && pending?.questionId === q.id && (
        <Banner kind={pending.status === "accepted" ? "success" : pending.status === "rejected" ? "danger" : "warn"}>
          {pending.status === "sending" ? t("room.answerSending") : pending.status === "accepted" ? "✓ " + t("room.answerAccepted") : pending.status === "unconfirmed" ? t("room.answerUnconfirmed") : t("room.answerRejected", { reason: t(`roomReason.${pending.reason ?? "closed"}` as never) })}
        </Banner>
      )}
      {!s.isHost && !reveal && !pending && s.myAnswer?.questionId === q.id && <Banner kind="success">✓ {t("room.answerAccepted")}</Banner>}
      {reveal && (
        <div className="card stack">
          {!s.isHost && <strong>{mine.length && mine.every((x) => reveal.correctOptionIds.includes(x)) && mine.length === reveal.correctOptionIds.length ? "✅ " + t("quiz.correct") : mine.length ? "❌ " + t("quiz.wrong") : t("room.timeUp")}</strong>}
          {reveal.explanation && <p className="small break">{reveal.explanation}</p>}
          {reveal.source && <p className="caption">📖 {reveal.source}</p>}
          {s.myScore && <p className="small">{t("room.myScore", { points: s.myScore.points })}</p>}
          <div><ReportButton questionId={q.id} /></div>
        </div>
      )}
      {reveal && <TeamBoard s={s} />}
    </div>
  );
}

function HostControls({ s, act }: { s: RoomStateView; act: (a: string) => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const run = (a: string) => async () => {
    setBusy(true);
    await act(a).finally(() => setBusy(false));
  };
  const lastQuestion = s.question ? s.question.index + 1 >= s.question.total : false;
  return (
    <div className="card stack" aria-label={t("room.hostPanel")}>
      <div className="row wrap">
        {s.status === "lobby" && <button className="btn btn-primary" disabled={busy || s.participants.length < 2} onClick={run("start")}>▶ {t("room.start")}</button>}
        {s.status === "running" && s.phase === "question" && <button className="btn btn-primary" disabled={busy} onClick={run("reveal")}>{t("room.reveal")}</button>}
        {s.status === "running" && s.phase === "reveal" && <button className="btn btn-primary" disabled={busy} onClick={run("next")}>{lastQuestion ? t("room.finish") : t("room.nextQuestion")}</button>}
        {s.status === "running" && <button className="btn btn-secondary" disabled={busy} onClick={run("pause")}>⏸ {t("room.pause")}</button>}
        {s.status === "paused" && <button className="btn btn-primary" disabled={busy} onClick={run("resume")}>▶ {t("room.resume")}</button>}
        {s.status !== "lobby" && <button className="btn btn-ghost" disabled={busy} onClick={run("finish")}>{t("room.finish")}</button>}
      </div>
    </div>
  );
}

function Finished({ s, roomId }: { s: RoomStateView; roomId: string }) {
  const t = useT();
  return (
    <div className="stack-l">
      {s.myScore && !s.isHost && (
        <div className="card stack" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 44 }} aria-hidden>🏁</div>
          <h2>{t("room.myResult")}</h2>
          <p>{t("room.myScoreFull", { points: s.myScore.points, correct: s.myScore.correct, total: s.question?.total ?? s.myScore.answered })}</p>
        </div>
      )}
      <TeamBoard s={s} />
      {s.leaderboard ? (
        <section className="card stack">
          <h2>{t("room.leaderboard")}</h2>
          {s.leaderboard.map((r, i) => (
            <div key={r.userId} className="lb-row">
              <span className="lb-rank">{i > 0 && s.leaderboard![i - 1]!.points === r.points ? "=" : i + 1}</span>
              <span className="avatar" aria-hidden>{r.name.slice(0, 1).toUpperCase()}</span>
              <span className="grow break">{r.name}</span>
              <strong>{r.points}</strong>
            </div>
          ))}
          <p className="caption">{t("room.tieRule")}</p>
        </section>
      ) : (
        <Banner kind="info">{t("room.leaderboardHidden")}</Banner>
      )}
      <Link to={`/`} className="btn btn-secondary">{t("nav.home")}</Link>
      <span className="sr-only">{roomId}</span>
    </div>
  );
}
