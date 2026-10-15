import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useMe } from "../lib/auth";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { Banner, Field } from "../components/ui";

/** Invite landing: no onboarding in the way — pick a display name and enter the room. */
export function Join() {
  const { token } = useParams();
  const me = useMe();
  const t = useT();
  const navigate = useNavigate();
  const [nick, setNick] = useState([me.user.firstName, me.user.lastName].filter(Boolean).join(" ").slice(0, 40));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ roomId: string }>("/api/rooms/join", { inviteToken: token, nickname: nick.trim() || undefined });
      navigate(`/room/${r.roomId}`, { replace: true });
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-l" style={{ paddingTop: 24 }}>
      <div className="state">
        <div className="state-icon" aria-hidden>🎯</div>
        <h1>{t("room.title")}</h1>
        <p className="muted">{t("room.joinIntro")}</p>
      </div>
      <Field label={t("room.nickname")}>{(id) => <input id={id} className="input" value={nick} maxLength={40} onChange={(e) => setNick(e.target.value)} />}</Field>
      {err && <Banner kind="danger">{err}</Banner>}
      <button className="btn btn-primary btn-block" disabled={busy} onClick={join}>{t("room.join")}</button>
      <p className="caption">{t("room.joinPrivacy")}</p>
    </div>
  );
}
