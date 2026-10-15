import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useMe } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { haptic } from "../../lib/telegram";
import { Badge, Empty, ErrorState, Loading, Screen, Toggle, toast } from "../../components/ui";

type Section = { title: string; where: string; points: { text: string; quote: string | null; verified: boolean; aiWritten: boolean }[]; terms: { term: string; definition: string }[] };

/** Konspekt: per-section key points quoted from the source (AI rewrite optional, every point re-checked against the text). */
export function Summary() {
  const { id } = useParams();
  const t = useT();
  const me = useMe();
  const [ai, setAi] = useState(false);
  const s = useQuery({ queryKey: ["summary", id, ai], queryFn: () => api.get<{ sections: Section[] }>(`/api/documents/${id}/summary${ai ? "?ai=1" : ""}`), staleTime: 5 * 60_000 });
  const [making, setMaking] = useState(false);
  const toCards = async () => {
    setMaking(true);
    try {
      const r = await api.post<{ created: number; found: number }>(`/api/flashcards/from-document/${id}`);
      haptic("success");
      toast(t("cards.created", { n: r.created }));
    } finally {
      setMaking(false);
    }
  };
  return (
    <Screen title={t("summary.title")}>
      <div className="stack-l">
        {me.features.ai && <Toggle label={t("summary.aiRewrite")} hint={t("summary.aiHint")} checked={ai} onChange={setAi} />}
        {s.isLoading ? <Loading lines={6} /> : s.isError ? <ErrorState error={s.error} onRetry={() => s.refetch()} /> : !s.data!.sections.length ? (
          <Empty text={t("summary.empty")} />
        ) : (
          <>
            {s.data!.sections.map((sec, i) => (
              <section key={i} className="card stack">
                {sec.title && <h2 className="section-title break">{sec.title}</h2>}
                <span className="caption">📖 {sec.where}</span>
                <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
                  {sec.points.map((p, j) => (
                    <li key={j} className="break">
                      {p.text}
                      {p.aiWritten && !p.verified && <> <Badge kind="warn">{t("tutor.unverified")}</Badge></>}
                    </li>
                  ))}
                </ul>
                {sec.terms.length > 0 && (
                  <dl className="stack small" style={{ margin: 0 }}>
                    {sec.terms.map((d, j) => (
                      <div key={j}><dt style={{ fontWeight: 600, display: "inline" }}>{d.term}</dt> — <dd style={{ display: "inline", margin: 0 }}>{d.definition}</dd></div>
                    ))}
                  </dl>
                )}
              </section>
            ))}
            <button className="btn btn-secondary btn-block" disabled={making} onClick={toCards}>🃏 {t("cards.fromDocument")}</button>
          </>
        )}
      </div>
    </Screen>
  );
}
