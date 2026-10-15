import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { Badge, Banner, Empty, ErrorState, Field, Loading, Screen, toast } from "../../components/ui";

type PlanItem = { id: string; title: string; exam_date: string; total: number; done: number };
type Task = { id: string; title: string; kind: string; topic: string | null; minutes: number | null; status: string; day: string; rescheduled_count: number };
type Plan = { id: string; title: string; exam_date: string; daily_minutes: number; today: string; overdue: number; tasks: Task[]; progress: { done: number; total: number }; timezone: string };

export function Plans() {
  const t = useT();
  const list = useQuery({ queryKey: ["plans"], queryFn: () => api.get<{ items: PlanItem[] }>("/api/plans") });
  return (
    <Screen title={t("plans.title")} actions={<Link className="btn btn-primary btn-sm" to="/plans/new">+ {t("plans.new")}</Link>}>
      {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.items.length ? (
        <Empty icon="🗓" text={t("plans.empty")} action={<Link className="btn btn-primary" to="/plans/new">{t("plans.new")}</Link>} />
      ) : (
        <div className="list">
          {list.data!.items.map((p) => (
            <Link key={p.id} to={`/plans/${p.id}`} className="list-item">
              <div className="grow">
                <div className="break" style={{ fontWeight: 600 }}>{p.title}</div>
                <div className="meta">{t("plans.examOn", { date: p.exam_date })} · {p.done}/{p.total}</div>
              </div>
              <span className="chev">›</span>
            </Link>
          ))}
        </div>
      )}
    </Screen>
  );
}

export function PlanNew() {
  const t = useT();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [topics, setTopics] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ planId: string }>("/api/plans", { title, examDate: date, dailyMinutes: minutes, topics: topics.split("\n").map((s) => s.trim()).filter(Boolean).map((name) => ({ name })) });
      navigate(`/plans/${r.planId}`, { replace: true });
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t("plans.new")}>
      <div className="stack">
        <Field label={t("plans.titleLabel")}>{(id) => <input id={id} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t("plans.examDate")}>{(id) => <input id={id} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label={t("plans.dailyMinutes")}>{(id) => <input id={id} className="input" type="number" min={10} max={600} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />}</Field>
        <Field label={t("plans.topics")} hint={t("plans.topicsHint")}>{(id) => <textarea id={id} className="textarea" rows={6} value={topics} onChange={(e) => setTopics(e.target.value)} />}</Field>
        {err && <Banner kind="danger">{err}</Banner>}
        <button className="btn btn-primary btn-block" disabled={busy || !title || !date || !topics.trim()} onClick={submit}>{t("plans.create")}</button>
      </div>
    </Screen>
  );
}

export function PlanDetail() {
  const { id } = useParams();
  const t = useT();
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["plan", id], queryFn: () => api.get<Plan>(`/api/plans/${id}`) });
  const [busy, setBusy] = useState(false);
  // set synchronously so the checkbox never snaps back while the server confirms
  const [local, setLocal] = useState<Record<string, string>>({});
  if (plan.isLoading) return <Screen title={t("plans.title")}><Loading /></Screen>;
  if (plan.isError) return <Screen title={t("plans.title")}><ErrorState error={plan.error} onRetry={() => plan.refetch()} /></Screen>;
  const p = plan.data!;
  const days = [...new Set(p.tasks.map((x) => x.day))];
  const setStatus = async (taskId: string, status: string) => {
    setLocal((m) => ({ ...m, [taskId]: status }));
    try {
      await api.patch(`/api/tasks/${taskId}`, { status });
    } catch (e) {
      toast(errorMessage(e, t));
    } finally {
      await qc.invalidateQueries({ queryKey: ["plan", id] });
      await qc.invalidateQueries({ queryKey: ["home"] });
      setLocal((m) => {
        const next = { ...m };
        delete next[taskId];
        return next;
      });
    }
  };
  const statusOf = (task: Task) => local[task.id] ?? task.status;
  const doneCount = p.tasks.filter((x) => statusOf(x) === "done").length;
  return (
    <Screen title={p.title}>
      <div className="stack-l">
        <div className="card stack">
          <div className="row between"><span>{t("plans.examOn", { date: p.exam_date })}</span><Badge kind="neutral">{p.timezone}</Badge></div>
          <div className="progress"><span style={{ width: `${(doneCount / Math.max(1, p.progress.total)) * 100}%` }} /></div>
          <span className="caption">{t("plans.progress", { done: doneCount, total: p.progress.total })}</span>
        </div>
        {p.overdue > 0 && (
          <Banner kind="info">
            <div className="stack" style={{ gap: 8 }}>
              <span>{t("plans.overdue", { n: p.overdue })}</span>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={async () => { setBusy(true); await api.post(`/api/plans/${id}/rebalance`).finally(() => setBusy(false)); await qc.invalidateQueries({ queryKey: ["plan", id] }); }}>{t("plans.rebalance")}</button>
            </div>
          </Banner>
        )}
        {days.map((d) => (
          <section key={d} className="stack">
            <h2 className="section-title">{d === p.today ? `${t("plans.today")} · ${d}` : d}</h2>
            <div className="list">
              {p.tasks.filter((x) => x.day === d).map((task) => (
                <label key={task.id} className="list-item">
                  <input type="checkbox" style={{ width: 22, height: 22 }} checked={statusOf(task) === "done"} onChange={(e) => setStatus(task.id, e.target.checked ? "done" : "todo")} aria-label={task.title} />
                  <div className="grow">
                    <div className="break" style={{ textDecoration: statusOf(task) === "done" ? "line-through" : undefined }}>{task.kind === "review" ? t("plans.review") : task.title}</div>
                    <div className="meta">{task.minutes} {t("plans.min")}{task.rescheduled_count ? ` · ${t("plans.moved")}` : ""}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>
        ))}
        {!p.tasks.length && <Empty text={t("plans.empty")} />}
      </div>
    </Screen>
  );
}
