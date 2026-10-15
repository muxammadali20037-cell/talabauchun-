import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LANG_LABELS, LANGS, type Lang, type ThemeId } from "@talaba/shared";
import { api, newIdempotencyKey } from "../../lib/api";
import { useMe } from "../../lib/auth";
import { useI18n } from "../../lib/i18n";
import { Banner, ErrorState, Field, Loading, Screen, Toggle } from "../../components/ui";
import type { DocSummary } from "../Library";
import { CostBanner, ThemePicker } from "./DeckParts";
import { deckError, MAX_SLIDES, MIN_SLIDES, type Estimate } from "./types";

type Detail = DocSummary & { sections: { id: string; title: string; level: number; start_page: number; end_page: number }[] };

/** Settings form for a new deck. Credits are shown before anything is reserved. */
export function DeckNew() {
  const { t, lang } = useI18n();
  const me = useMe();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const profile = (me.profile ?? {}) as { university?: string | null };
  const [docIds, setDocIds] = useState<string[]>(params.get("doc") ? [params.get("doc")!] : []);
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [pageFrom, setPageFrom] = useState("");
  const [pageTo, setPageTo] = useState("");
  const [topic, setTopic] = useState("");
  const [topicTouched, setTopicTouched] = useState(false);
  const [audience, setAudience] = useState(t("deck.audienceDefault"));
  const [duration, setDuration] = useState(10);
  const [slideCount, setSlideCount] = useState(12);
  const [theme, setTheme] = useState<ThemeId>("academic");
  const [deckLang, setDeckLang] = useState<Lang>(me.user.language ?? lang);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState([me.user.firstName, me.user.lastName].filter(Boolean).join(" "));
  const [university, setUniversity] = useState(profile.university ?? "");
  const [subject, setSubject] = useState("");
  const [teacher, setTeacher] = useState("");
  const [group, setGroup] = useState("");
  const [requirements, setRequirements] = useState("");
  const [speech, setSpeech] = useState(true);
  const [defenseQa, setDefenseQa] = useState(true);
  const [useAi, setUseAi] = useState(true);
  const [planOnly, setPlanOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const idem = useMemo(() => newIdempotencyKey("deck"), []);
  const aiOn = me.features.ai && useAi;

  const docs = useQuery({ queryKey: ["documents", "ready"], queryFn: () => api.get<{ items: DocSummary[] }>("/api/documents?limit=50") });
  const ready = (docs.data?.items ?? []).filter((d) => d.version && ["ready", "partial"].includes(d.version.status));
  const single = docIds.length === 1 ? docIds[0]! : null;
  const detail = useQuery({ queryKey: ["document", single], enabled: !!single, queryFn: () => api.get<Detail>(`/api/documents/${single}`) });
  const estimate = useQuery({
    queryKey: ["deck-estimate", slideCount, aiOn, planOnly],
    queryFn: () => api.post<Estimate>("/api/decks/estimate", { slideCount, useAi: aiOn, planOnly }),
  });

  // The first chosen document's title is a sensible default topic until the student types one.
  useEffect(() => {
    if (topicTouched) return;
    const first = ready.find((d) => d.id === docIds[0]);
    setTopic(first ? first.title : "");
  }, [docIds, ready.length, topicTouched]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSectionIds([]);
    setPageFrom("");
    setPageTo("");
  }, [single]);

  const pages = detail.data?.version?.pageCount ?? 0;
  const from = Number(pageFrom);
  const to = Number(pageTo);
  const rangeSet = pageFrom !== "" || pageTo !== "";
  const rangeValid = !rangeSet || (from >= 1 && to >= from && (!pages || to <= pages));
  const needSource = !aiOn && docIds.length === 0;
  const canSubmit = !busy && topic.trim().length >= 2 && !needSource && rangeValid && slideCount >= MIN_SLIDES && slideCount <= MAX_SLIDES;

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const settings = {
        language: deckLang, topic: topic.trim(), audience: audience.trim() || t("deck.audienceDefault"), durationMin: duration, slideCount, theme,
        ...(author.trim() ? { author: author.trim() } : {}),
        ...(university.trim() ? { university: university.trim() } : {}),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        ...(teacher.trim() ? { teacher: teacher.trim() } : {}),
        ...(group.trim() ? { group: group.trim() } : {}),
        ...(requirements.trim() ? { requirements: requirements.trim() } : {}),
        extras: { speech, defenseQa, handout: false },
      };
      const r = await api.post<{ deckId: string; jobId: string }>("/api/decks", {
        settings,
        documentIds: docIds,
        ...(single && sectionIds.length ? { sectionIds } : {}),
        ...(single && rangeSet ? { pageRanges: [{ documentId: single, from, to }] } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        useAi: aiOn,
        planOnly,
        idempotencyKey: idem,
      });
      navigate(`/decks/${r.deckId}`, { replace: true });
    } catch (e) {
      setErr(deckError(e, t));
      setBusy(false);
    }
  };

  return (
    <Screen title={t("deck.create")}>
      <div className="stack-l">
        {!me.features.ai && <Banner kind="info">{t("deck.aiOff")}</Banner>}

        <section className="stack" aria-labelledby="deck-materials">
          <span id="deck-materials" className="label">{t("deck.materials")}</span>
          {docs.isLoading ? (
            <Loading lines={2} />
          ) : docs.isError ? (
            <ErrorState error={docs.error} onRetry={() => docs.refetch()} />
          ) : !ready.length ? (
            <div className="stack">
              <Banner kind="warn">{t("deck.noMaterials")}</Banner>
              <Link className="btn btn-secondary" to="/library/upload">📤 {t("deck.uploadMaterial")}</Link>
            </div>
          ) : (
            <div className="list">
              {ready.map((d) => (
                <label key={d.id} className="list-item">
                  <input type="checkbox" className="deck-check" checked={docIds.includes(d.id)} onChange={(e) => setDocIds(e.target.checked ? [...docIds, d.id] : docIds.filter((x) => x !== d.id))} />
                  <span className="grow break">{d.title}</span>
                  <span className="meta">{d.sourceKind.toUpperCase()}</span>
                </label>
              ))}
            </div>
          )}
          {aiOn && !docIds.length && <p className="caption">{t("deck.noMaterialAi")}</p>}
          {needSource && ready.length > 0 && <p className="error-text">{t("deck.needSource")}</p>}
        </section>

        {single && !!detail.data?.sections.filter((s) => s.level === 1).length && (
          <section className="stack" aria-labelledby="deck-chapters">
            <span id="deck-chapters" className="label">{t("deck.chapters")}</span>
            <div className="list">
              {detail.data.sections.filter((s) => s.level === 1).map((s) => (
                <label key={s.id} className="list-item">
                  <input type="checkbox" className="deck-check" checked={sectionIds.includes(s.id)} onChange={(e) => setSectionIds(e.target.checked ? [...sectionIds, s.id] : sectionIds.filter((x) => x !== s.id))} />
                  <span className="grow break">{s.title}</span>
                </label>
              ))}
            </div>
            <p className="caption">{t("deck.allChaptersHint")}</p>
          </section>
        )}

        {single && pages > 1 && (
          <section className="stack" aria-labelledby="deck-range">
            <span id="deck-range" className="label">{t("deck.pageRange")}</span>
            <div className="grid-2">
              <Field label={t("deck.pageFrom")}>{(id) => <input id={id} className="input" type="number" inputMode="numeric" min={1} max={pages} value={pageFrom} onChange={(e) => setPageFrom(e.target.value)} />}</Field>
              <Field label={t("deck.pageTo")}>{(id) => <input id={id} className="input" type="number" inputMode="numeric" min={1} max={pages} value={pageTo} onChange={(e) => setPageTo(e.target.value)} />}</Field>
            </div>
            {!rangeValid && <p className="error-text">{t("deck.err.invalid_page_range")}</p>}
          </section>
        )}

        <Field label={t("deck.topic")} hint={t("deck.topicHint")}>
          {(id) => <input id={id} className="input" value={topic} maxLength={300} onChange={(e) => (setTopic(e.target.value), setTopicTouched(true))} />}
        </Field>

        <div className="grid-2">
          <Field label={t("deck.slideCount")} hint={t("deck.slideCountHint", { min: MIN_SLIDES, max: MAX_SLIDES })}>
            {(id) => <input id={id} className="input" type="number" inputMode="numeric" min={MIN_SLIDES} max={MAX_SLIDES} value={slideCount} onChange={(e) => setSlideCount(Math.round(Number(e.target.value) || 0))} />}
          </Field>
          <Field label={t("deck.duration")}>
            {(id) => <input id={id} className="input" type="number" inputMode="numeric" min={1} max={120} value={duration} onChange={(e) => setDuration(Math.max(1, Math.min(120, Math.round(Number(e.target.value) || 1))))} />}
          </Field>
        </div>

        <section className="stack" aria-labelledby="deck-style">
          <span id="deck-style" className="label">{t("deck.style")}</span>
          <ThemePicker value={theme} onChange={setTheme} />
          <p className="caption">{t("deck.themeHint")}</p>
        </section>

        <Field label={t("deck.audience")}>{(id) => <input id={id} className="input" value={audience} maxLength={200} onChange={(e) => setAudience(e.target.value)} />}</Field>

        <details className="more">
          <summary>{t("common.moreSettings")}</summary>
          <div className="stack">
            <Field label={t("deck.titleLabel")}>{(id) => <input id={id} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <div className="grid-2 deck-grid-fields">
              <Field label={t("deck.author")}>{(id) => <input id={id} className="input" value={author} maxLength={200} onChange={(e) => setAuthor(e.target.value)} />}</Field>
              <Field label={t("deck.group")}>{(id) => <input id={id} className="input" value={group} maxLength={100} onChange={(e) => setGroup(e.target.value)} />}</Field>
              <Field label={t("deck.subject")}>{(id) => <input id={id} className="input" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />}</Field>
              <Field label={t("deck.teacher")}>{(id) => <input id={id} className="input" value={teacher} maxLength={200} onChange={(e) => setTeacher(e.target.value)} />}</Field>
            </div>
            <Field label={t("deck.university")}>{(id) => <input id={id} className="input" value={university} maxLength={200} onChange={(e) => setUniversity(e.target.value)} />}</Field>
            <Field label={t("deck.teacherReq")}>{(id) => <textarea id={id} className="textarea" rows={4} maxLength={5000} value={requirements} onChange={(e) => setRequirements(e.target.value)} />}</Field>
            <Field label={t("deck.deckLanguage")}>
              {(id) => (
                <select id={id} className="select" value={deckLang} onChange={(e) => setDeckLang(e.target.value as Lang)}>
                  {LANGS.map((l) => (
                    <option key={l} value={l}>{LANG_LABELS[l]}</option>
                  ))}
                </select>
              )}
            </Field>
            <span className="label">{t("deck.extras")}</span>
            <Toggle label={t("deck.speech")} checked={speech} onChange={setSpeech} />
            <Toggle label={t("deck.defenseQa")} checked={defenseQa} onChange={setDefenseQa} />
            {me.features.ai && <Toggle label={t("deck.useAi")} checked={useAi} onChange={setUseAi} hint={t("deck.useAiHint")} />}
          </div>
        </details>

        <Toggle label={t("deck.planFirst")} checked={planOnly} onChange={setPlanOnly} hint={t("deck.planFirstHint")} />

        {estimate.data && <CostBanner estimate={estimate.data} />}
        {err && <Banner kind="danger">{err}</Banner>}
        <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
          {busy && <span className="spinner" aria-hidden />}
          {planOnly ? t("deck.makePlan") : t("deck.buildDeck")}
        </button>
      </div>
    </Screen>
  );
}
