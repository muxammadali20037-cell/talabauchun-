import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { haptic, openInvoice } from "../../lib/telegram";
import { Badge, Banner, ErrorState, Loading, Screen } from "../../components/ui";

type Plan = { code: string; title: string; priceStars: number; credits: number; periodDays: number | null; limits: Record<string, number>; purchasable: boolean };
type Billing = {
  paymentsEnabled: boolean; balance: number; pricing: Record<string, number>; plans: Plan[];
  current: { planCode: string; endsAt: string | null; maxQuestionsPerQuiz: number; maxSlides: number; maxUploadMb: number; maxOcrPagesPerMonth: number };
};
type History = { ledger: { id: string; entry_type: string; amount: number; reason: string | null; created_at: string }[]; payments: { id: string; plan_code: string; amount: number; credits: number; status: string; created_at: string }[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plans, what each action costs, balance and history. Buying uses Telegram Stars; credits appear only after the server confirms the payment. */
export function Billing() {
  const t = useT();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const b = useQuery({ queryKey: ["billing"], queryFn: () => api.get<Billing>("/api/billing") });
  const h = useQuery({ queryKey: ["billing-history"], queryFn: () => api.get<History>("/api/billing/history") });
  const [msg, setMsg] = useState<{ kind: "info" | "success" | "danger" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const buy = async (plan: Plan) => {
    setBusy(plan.code);
    setMsg(null);
    try {
      const inv = await api.post<{ paymentId: string; link: string }>("/api/billing/invoice", { planCode: plan.code });
      const status = await openInvoice(inv.link);
      if (status === "unsupported") {
        setMsg({ kind: "warn", text: t("billing.updateTelegram") });
        return;
      }
      if (status === "cancelled" || status === "failed") {
        await api.post(`/api/billing/payments/${inv.paymentId}/cancel`).catch(() => {});
        setMsg({ kind: status === "failed" ? "danger" : "info", text: status === "failed" ? t("billing.failed") : t("billing.cancelled") });
        return;
      }
      // "paid" from the client is only a hint: wait for the server to record successful_payment
      setMsg({ kind: "info", text: t("billing.confirming") });
      for (let i = 0; i < 20; i++) {
        const p = await api.get<{ status: string; balance: number }>(`/api/billing/payments/${inv.paymentId}`);
        if (p.status === "paid") {
          haptic("success");
          setMsg({ kind: "success", text: t("billing.paid", { credits: plan.credits, balance: p.balance }) });
          await Promise.all([qc.invalidateQueries({ queryKey: ["billing"] }), qc.invalidateQueries({ queryKey: ["billing-history"] }), refresh()]);
          return;
        }
        if (p.status === "failed") break;
        await sleep(1500);
      }
      setMsg({ kind: "warn", text: t("billing.notConfirmedYet") });
    } catch (e) {
      setMsg({ kind: "danger", text: errorMessage(e, t) });
    } finally {
      setBusy(null);
    }
  };

  if (b.isLoading) return <Screen title={t("billing.title")}><Loading /></Screen>;
  if (b.isError) return <Screen title={t("billing.title")}><ErrorState error={b.error} onRetry={() => b.refetch()} /></Screen>;
  const d = b.data!;
  const price = d.pricing;
  return (
    <Screen title={t("billing.title")}>
      <div className="stack-l">
        <section className="card stack">
          <div className="row between wrap">
            <h2>{t("profile.balance", { n: d.balance })}</h2>
            <Badge kind="primary">{d.plans.find((p) => p.code === d.current.planCode)?.title ?? d.current.planCode}</Badge>
          </div>
          {d.current.endsAt && <p className="caption">{t("billing.until", { date: new Date(d.current.endsAt).toLocaleDateString() })}</p>}
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t("billing.limitQuestions", { n: d.current.maxQuestionsPerQuiz })}</li>
            <li>{t("billing.limitSlides", { n: d.current.maxSlides })}</li>
            <li>{t("billing.limitUpload", { n: d.current.maxUploadMb })}</li>
            <li>{t("billing.limitOcr", { n: d.current.maxOcrPagesPerMonth })}</li>
          </ul>
          <p className="caption">{t("profile.creditsHint")}</p>
        </section>

        <section className="card stack">
          <h3>{t("billing.costs")}</h3>
          <dl className="cost-list small">
            <dt>{t("billing.costQuizAi")}</dt><dd>{t("billing.perCredit", { n: price.quizAiQuestionsPerCredit ?? 0 })}</dd>
            <dt>{t("billing.costQuizNoAi")}</dt><dd>{t("billing.perCredit", { n: price.quizExtractiveQuestionsPerCredit ?? 0 })}</dd>
            <dt>{t("billing.costDeckAi")}</dt><dd>{t("billing.creditsPerSlide", { n: price.deckAiCreditsPerSlide ?? 0 })}</dd>
            <dt>{t("billing.costOcr")}</dt><dd>{t("billing.pagesPerCredit", { n: price.ocrPagesPerCredit ?? 0 })}</dd>
          </dl>
          <p className="caption">{t("billing.costsHint")}</p>
        </section>

        <section className="stack">
          <h2 className="section-title">{t("billing.plans")}</h2>
          {!d.paymentsEnabled && <Banner kind="info">{t("bot.paymentsDisabled")}</Banner>}
          {d.plans.filter((p) => p.code !== "free").length === 0 && <p className="caption">{t("billing.noPlans")}</p>}
          {d.plans.map((p) => (
            <article key={p.code} className="card stack">
              <div className="row between wrap">
                <strong>{p.title}</strong>
                {p.purchasable ? <span className="badge badge-warn">⭐ {p.priceStars}</span> : <Badge kind="neutral">{t("billing.free")}</Badge>}
              </div>
              <p className="small">{t("billing.planCredits", { credits: p.credits, days: p.periodDays ?? 30 })}</p>
              {p.purchasable && (
                <button className="btn btn-primary" disabled={!d.paymentsEnabled || busy !== null} onClick={() => buy(p)}>
                  {busy === p.code ? t("billing.opening") : t("billing.buyStars", { n: p.priceStars })}
                </button>
              )}
            </article>
          ))}
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          <p className="caption">{t("billing.refundPolicy")} <Link to="/support?kind=paysupport">{t("billing.paySupport")}</Link></p>
        </section>

        <section className="stack">
          <h2 className="section-title">{t("billing.history")}</h2>
          {h.isLoading ? <Loading lines={2} /> : !h.data?.ledger.length ? <p className="caption">{t("billing.noHistory")}</p> : (
            <div className="list">
              {h.data.ledger.map((l) => (
                <div key={l.id} className="list-item">
                  <div className="grow">
                    <div className="small">{t(`ledger.${l.entry_type}` as never)}</div>
                    <div className="meta">{new Date(l.created_at).toLocaleString()}</div>
                  </div>
                  <strong style={{ color: l.amount < 0 ? "var(--c-danger)" : l.amount > 0 ? "var(--c-success)" : undefined }}>{l.amount > 0 ? "+" : ""}{l.amount}</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Screen>
  );
}
