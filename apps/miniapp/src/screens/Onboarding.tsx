import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LANG_LABELS, LANGS, type Lang } from "@talaba/shared";
import { api } from "../lib/api";
import { useAuth, useMe } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { Field } from "../components/ui";

type Goal = "presentation" | "quiz" | "book" | "question";

/** Three short, skippable steps: language → goal → optional study profile. */
export function Onboarding() {
  const me = useMe();
  const { t, lang, setLang } = useI18n();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(me.user.languageConfirmed ? 1 : 0);
  const [profile, setProfile] = useState({ university: "", faculty: "", course: "", specialty: "" });
  const [eduRole, setEduRole] = useState<"student" | "teacher">(me.user.eduRole ?? "student");
  const [saving, setSaving] = useState(false);

  const finish = async (goal?: Goal) => {
    setSaving(true);
    try {
      await api.patch("/api/me", {
        language: lang,
        onboarded: true,
        eduRole,
        ...(goal ? { onboardingGoal: goal } : {}),
        profile: {
          university: profile.university || null,
          faculty: profile.faculty || null,
          specialty: profile.specialty || null,
          course: profile.course ? Number(profile.course) : null,
        },
      });
      await refresh();
    } finally {
      setSaving(false);
    }
    const dest: Record<Goal, string> = { presentation: "/decks/new", quiz: "/quiz/new", book: "/library/upload", question: "/library" };
    navigate(goal ? dest[goal] : "/", { replace: true });
  };

  return (
    <div className="stack-l" style={{ paddingTop: 16 }}>
      <div className="progress" aria-label={`${step + 1}/3`}>
        <span style={{ width: `${((step + 1) / 3) * 100}%` }} />
      </div>
      {step === 0 && (
        <section className="stack">
          <h1>{t("onboarding.chooseLang")}</h1>
          <div className="list" role="radiogroup">
            {LANGS.map((l: Lang) => (
              <button key={l} role="radio" aria-checked={l === lang} className="list-item" onClick={() => setLang(l)}>
                <span className="grow">{LANG_LABELS[l]}</span>
                {l === lang && <span aria-hidden>✓</span>}
              </button>
            ))}
          </div>
          <button className="btn btn-primary btn-block" onClick={() => setStep(1)}>
            {t("common.continue")}
          </button>
        </section>
      )}
      {step === 1 && (
        <section className="stack">
          <h1>{t("onboarding.goalTitle")}</h1>
          <div className="grid-2">
            {(
              [
                ["presentation", "📊", "onboarding.goalPresentation"],
                ["quiz", "📝", "onboarding.goalQuiz"],
                ["book", "📚", "onboarding.goalBook"],
                ["question", "❓", "onboarding.goalQuestion"],
              ] as const
            ).map(([g, ico, key]) => (
              <button key={g} className="tile" disabled={saving} onClick={() => (setStep(2), sessionStorage.setItem("talaba.goal", g))}>
                <span className="tile-icon" aria-hidden>
                  {ico}
                </span>
                <strong>{t(key)}</strong>
              </button>
            ))}
          </div>
          <button className="btn btn-ghost" onClick={() => setStep(2)}>
            {t("onboarding.skip")}
          </button>
        </section>
      )}
      {step === 2 && (
        <section className="stack">
          <h1>{t("onboarding.profileTitle")}</h1>
          <div className="segmented" role="group" aria-label={t("profile.eduRole")}>
            {(["student", "teacher"] as const).map((r) => (
              <button key={r} aria-pressed={eduRole === r} onClick={() => setEduRole(r)}>
                {t(r === "student" ? "onboarding.roleStudent" : "onboarding.roleTeacher")}
              </button>
            ))}
          </div>
          {(["university", "faculty", "specialty"] as const).map((k) => (
            <Field key={k} label={t(`onboarding.${k}`)}>
              {(id) => <input id={id} className="input" value={profile[k]} maxLength={200} onChange={(e) => setProfile({ ...profile, [k]: e.target.value })} />}
            </Field>
          ))}
          <Field label={t("onboarding.course")}>
            {(id) => (
              <select id={id} className="select" value={profile.course} onChange={(e) => setProfile({ ...profile, course: e.target.value })}>
                <option value="">—</option>
                {[1, 2, 3, 4, 5, 6].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <button className="btn btn-primary btn-block" disabled={saving} onClick={() => finish((sessionStorage.getItem("talaba.goal") as Goal) ?? undefined)}>
            {t("common.continue")}
          </button>
          <button className="btn btn-ghost" disabled={saving} onClick={() => finish((sessionStorage.getItem("talaba.goal") as Goal) ?? undefined)}>
            {t("onboarding.skip")}
          </button>
        </section>
      )}
    </div>
  );
}
