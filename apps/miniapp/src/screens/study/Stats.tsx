import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { Badge, Banner, Empty, ErrorState, Field, Loading, Screen, Toggle } from "../../components/ui";

type Table = { sheet: string; columns: string[]; rows: (string | number | null)[][]; truncated: boolean };
type Fact = { id: string; indicator: string; value: number; unit: string; period: string; is_example: boolean; quote: string | null; document_title: string | null; locator: { sheet?: string; row?: number } };
type Computed = { value: number; unit: string; formula: string; denominator: string | null; isExample: boolean };

const fmt = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);

/** Statistics from the user's own table: exact cell values become sourced facts → chart → computed change → quiz. */
export function Stats() {
  const { id } = useParams();
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tables = useQuery({ queryKey: ["tables", id], queryFn: () => api.get<{ tables: Table[] }>(`/api/documents/${id}/tables`) });
  const facts = useQuery({ queryKey: ["facts", id], queryFn: () => api.get<{ items: Fact[] }>(`/api/documents/${id}/facts`) });
  const [sheet, setSheet] = useState<string>("");
  const [labelCol, setLabelCol] = useState(0);
  const [valueCol, setValueCol] = useState(1);
  const [indicator, setIndicator] = useState("");
  const [unit, setUnit] = useState("");
  const [example, setExample] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const table = tables.data?.tables.find((x) => x.sheet === (sheet || tables.data?.tables[0]?.sheet));
  const series = useMemo(() => {
    const m = new Map<string, Fact[]>();
    for (const f of facts.data?.items ?? []) m.set(f.indicator, [...(m.get(f.indicator) ?? []), f]);
    return [...m.entries()];
  }, [facts.data]);

  const createFacts = async () => {
    if (!table) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/stats/facts", { documentId: id, sheet: table.sheet, labelColumn: labelCol, valueColumn: valueCol, indicator: indicator.trim(), unit: unit.trim(), isExample: example || undefined });
      await qc.invalidateQueries({ queryKey: ["facts", id] });
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (tables.isLoading) return <Screen title={t("stats.title")}><Loading /></Screen>;
  if (tables.isError) return <Screen title={t("stats.title")}><ErrorState error={tables.error} onRetry={() => tables.refetch()} /></Screen>;
  if (!tables.data!.tables.length) return <Screen title={t("stats.title")}><Empty icon="📈" text={t("stats.noTables")} /></Screen>;
  return (
    <Screen title={t("stats.title")}>
      <div className="stack-l">
        <section className="card stack">
          <h2 className="section-title">{t("stats.fromTable")}</h2>
          {tables.data!.tables.length > 1 && (
            <Field label={t("stats.sheet")}>{(fid) => (
              <select id={fid} className="input" value={table?.sheet} onChange={(e) => setSheet(e.target.value)}>
                {tables.data!.tables.map((x) => <option key={x.sheet} value={x.sheet}>{x.sheet}</option>)}
              </select>
            )}</Field>
          )}
          {table && (
            <>
              <div className="grid-2">
                <Field label={t("stats.labelColumn")}>{(fid) => (
                  <select id={fid} className="input" value={labelCol} onChange={(e) => setLabelCol(Number(e.target.value))}>
                    {table.columns.map((c, i) => <option key={i} value={i}>{c}</option>)}
                  </select>
                )}</Field>
                <Field label={t("stats.valueColumn")}>{(fid) => (
                  <select id={fid} className="input" value={valueCol} onChange={(e) => { setValueCol(Number(e.target.value)); if (!indicator) setIndicator(table.columns[Number(e.target.value)] ?? ""); }}>
                    {table.columns.map((c, i) => <option key={i} value={i}>{c}</option>)}
                  </select>
                )}</Field>
              </div>
              <div className="scroll-x">
                <table className="data-table small">
                  <thead><tr>{table.columns.map((c, i) => <th key={i} scope="col" className={i === valueCol ? "hl" : undefined}>{c}</th>)}</tr></thead>
                  <tbody>{table.rows.slice(0, 6).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j === valueCol ? "hl" : undefined}>{c ?? ""}</td>)}</tr>)}</tbody>
                </table>
              </div>
              <div className="grid-2">
                <Field label={t("stats.indicator")}>{(fid) => <input id={fid} className="input" value={indicator} maxLength={300} onChange={(e) => setIndicator(e.target.value)} />}</Field>
                <Field label={t("stats.unit")} hint={t("stats.unitHint")}>{(fid) => <input id={fid} className="input" value={unit} maxLength={60} onChange={(e) => setUnit(e.target.value)} />}</Field>
              </div>
              <Toggle label={t("stats.isExample")} hint={t("stats.isExampleHint")} checked={example} onChange={setExample} />
              {err && <Banner kind="danger">{err}</Banner>}
              <button className="btn btn-primary" disabled={busy || !indicator.trim() || !unit.trim()} onClick={createFacts}>{t("stats.saveFacts")}</button>
            </>
          )}
        </section>
        {series.map(([name, items]) => <Series key={name} documentId={id!} name={name} items={items} onQuiz={(quizId) => navigate(`/quiz/${quizId}/edit`)} />)}
      </div>
    </Screen>
  );
}

function Series({ documentId, name, items, onQuiz }: { documentId: string; name: string; items: Fact[]; onQuiz: (id: string) => void }) {
  const t = useT();
  const [a, setA] = useState(items[0]?.id ?? "");
  const [b, setB] = useState(items[items.length - 1]?.id ?? "");
  const [res, setRes] = useState<Computed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const max = Math.max(...items.map((f) => Math.abs(f.value)), 1);
  const example = items.some((f) => f.is_example);
  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr(errorMessage(e, t)); }
  };
  return (
    <section className="card stack">
      <div className="row between wrap">
        <h2 className="section-title break">{name}</h2>
        {example && <Badge kind="warn">{t("stats.exampleData")}</Badge>}
      </div>
      <figure className="stack" style={{ margin: 0 }}>
        <div className="bars" aria-hidden>
          {items.map((f) => (
            <div key={f.id} className="bar-row">
              <span className="caption bar-label">{f.period}</span>
              <span className="bar"><span style={{ width: `${(Math.abs(f.value) / max) * 100}%` }} /></span>
              <span className="small">{fmt(f.value)}</span>
            </div>
          ))}
        </div>
        <figcaption className="caption">{items[0]?.unit} · 📖 {items[0]?.document_title}{items[0]?.locator.sheet ? `, ${items[0].locator.sheet}` : ""}</figcaption>
        <table className="sr-only">
          <caption>{name}</caption>
          <tbody>{items.map((f) => <tr key={f.id}><th scope="row">{f.period}</th><td>{fmt(f.value)} {f.unit}</td></tr>)}</tbody>
        </table>
      </figure>
      <div className="grid-2">
        <Field label={t("stats.from")}>{(fid) => <select id={fid} className="input" value={a} onChange={(e) => setA(e.target.value)}>{items.map((f) => <option key={f.id} value={f.id}>{f.period}</option>)}</select>}</Field>
        <Field label={t("stats.to")}>{(fid) => <select id={fid} className="input" value={b} onChange={(e) => setB(e.target.value)}>{items.map((f) => <option key={f.id} value={f.id}>{f.period}</option>)}</select>}</Field>
      </div>
      <button className="btn btn-secondary" disabled={!a || !b || a === b} onClick={() => run(async () => setRes(await api.post<Computed>("/api/stats/compute", { aId: a, bId: b, op: "pct_change" })))}>{t("stats.computeChange")}</button>
      {res && (
        <div className="evidence">
          <strong>{res.value > 0 ? "+" : ""}{fmt(res.value)} {res.unit}</strong>
          <div className="caption">{t("stats.formula")}: {res.formula}{res.denominator ? ` · ${t("stats.base")}: ${res.denominator}` : ""}</div>
        </div>
      )}
      <button className="btn btn-primary" disabled={items.length < 4} onClick={() => run(async () => onQuiz((await api.post<{ quizId: string }>("/api/stats/quiz", { documentId, indicator: name })).quizId))}>📝 {t("stats.makeQuiz")}</button>
      {items.length < 4 && <p className="caption">{t("stats.needFour")}</p>}
      {err && <Banner kind="danger">{err}</Banner>}
    </section>
  );
}
