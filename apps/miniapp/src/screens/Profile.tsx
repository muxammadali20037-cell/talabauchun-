import { useState } from "react";
import { Link } from "react-router-dom";
import { LANG_LABELS, LANGS, type Lang } from "@talaba/shared";
import { api } from "../lib/api";
import { useAuth, useMe } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { Badge, Banner, Field, SaveState, Screen, Segmented, Toggle } from "../components/ui";

const TIMEZONES = ["Asia/Tashkent", "Asia/Samarkand", "Asia/Almaty", "Asia/Bishkek", "Asia/Dushanbe", "Europe/Moscow", "Europe/Istanbul", "Asia/Dubai", "Asia/Seoul", "Europe/Berlin", "Europe/London", "America/New_York", "UTC"];

export function Profile() {
  const me = useMe();
  const { refresh } = useAuth();
  const { t, setLang } = useI18n();
  const p = (me.profile ?? {}) as { notifications_enabled?: boolean; quiet_hours_start?: number | null; quiet_hours_end?: number | null; university?: string | null };
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const patch = async (body: Record<string, unknown>) => {
    setState("saving");
    setErr(null);
    try {
      await api.patch("/api/me", body);
      await refresh();
      setState("saved");
    } catch (e) {
      setState("error");
      setErr(errorMessage(e, t));
    }
  };
  return (
    <Screen title={t("profile.title")} back={false} actions={<SaveState state={state} />}>
      <div className="stack-l">
        <div className="card row">
          <span className="avatar" aria-hidden>{(me.user.firstName || "?").slice(0, 1)}</span>
          <div className="grow">
            <strong>{[me.user.firstName, me.user.lastName].filter(Boolean).join(" ")}</strong>
            {me.user.username && <div className="caption">@{me.user.username}</div>}
          </div>
          {me.user.platformRole === "admin" && <Link className="btn btn-secondary btn-sm" to="/admin">Admin</Link>}
        </div>
        {err && <Banner kind="danger">{err}</Banner>}

        <section className="card stack">
          <h3>{t("profile.credits")}</h3>
          <p>{t("profile.balance", { n: me.balance })}</p>
          <p className="caption">{t("profile.creditsHint")}</p>
          <Link className="btn btn-secondary" to="/billing">⭐ {t("billing.title")}</Link>
        </section>

        <section className="card stack">
          <Field label={t("profile.language")}>
            {(id) => (
              <select id={id} className="select" value={me.user.language} onChange={(e) => { setLang(e.target.value as Lang); void patch({ language: e.target.value }); }}>
                {LANGS.map((l) => <option key={l} value={l}>{LANG_LABELS[l]}</option>)}
              </select>
            )}
          </Field>
          <span className="label">{t("profile.eduRole")}</span>
          <Segmented label={t("profile.eduRole")} value={me.user.eduRole ?? "student"} onChange={(v) => patch({ eduRole: v })} options={[{ value: "student", label: t("onboarding.roleStudent") }, { value: "teacher", label: t("onboarding.roleTeacher") }]} />
          <p className="caption">{t("profile.eduRoleHint")}</p>
          <Field label={t("profile.timezone")}>
            {(id) => (
              <select id={id} className="select" value={me.user.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
                {(TIMEZONES.includes(me.user.timezone) ? TIMEZONES : [me.user.timezone, ...TIMEZONES]).map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            )}
          </Field>
        </section>

        <section className="card stack">
          <Toggle label={t("profile.notifications")} checked={p.notifications_enabled ?? true} onChange={(v) => patch({ profile: { notificationsEnabled: v } })} />
          <span className="label">{t("profile.quietHours")}</span>
          <div className="row">
            <select aria-label={t("profile.quietFrom")} className="select" value={p.quiet_hours_start ?? ""} onChange={(e) => patch({ profile: { quietHoursStart: e.target.value === "" ? null : Number(e.target.value) } })}>
              <option value="">—</option>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
            <span aria-hidden>–</span>
            <select aria-label={t("profile.quietTo")} className="select" value={p.quiet_hours_end ?? ""} onChange={(e) => patch({ profile: { quietHoursEnd: e.target.value === "" ? null : Number(e.target.value) } })}>
              <option value="">—</option>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </div>
        </section>

        <section className="list">
          <Link className="list-item" to="/help"><span className="grow">❔ {t("profile.help")}</span><span className="chev">›</span></Link>
          <Link className="list-item" to="/support"><span className="grow">💬 {t("profile.support")}</span><span className="chev">›</span></Link>
          <Link className="list-item" to="/profile/data"><span className="grow">📦 {t("data.title")}</span><span className="chev">›</span></Link>
          <Link className="list-item" to="/privacy"><span className="grow">🔐 {t("profile.privacy")}</span><span className="chev">›</span></Link>
          <Link className="list-item" to="/terms"><span className="grow">📄 {t("profile.terms")}</span><span className="chev">›</span></Link>
        </section>
        <div className="row wrap">
          <Badge kind={me.features.ai ? "success" : "neutral"}>AI: {me.features.ai ? t("profile.on") : t("profile.off")}</Badge>
          <Badge kind="neutral">v0.1</Badge>
        </div>
      </div>
    </Screen>
  );
}
