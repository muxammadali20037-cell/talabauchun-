import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { Badge, Banner, Field, Loading, Screen, Segmented } from "../../components/ui";

type Ticket = { id: string; kind: string; body: string; status: string; resolution: string | null; created_at: string };
type Kind = "support" | "paysupport" | "content_error";

export function Support() {
  const t = useT();
  const [params] = useSearchParams();
  const initial = (["support", "paysupport", "content_error"] as const).find((k) => k === params.get("kind")) ?? "support";
  const [kind, setKind] = useState<Kind>(initial);
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<{ kind: "success" | "danger"; text: string } | null>(null);
  const list = useQuery({ queryKey: ["tickets"], queryFn: () => api.get<{ items: Ticket[] }>("/api/support") });
  const send = async () => {
    setMsg(null);
    try {
      const r = await api.post<{ ticketId: string }>("/api/support", { kind, body });
      setBody("");
      setMsg({ kind: "success", text: t("bot.supportReceived", { id: r.ticketId }) });
      await list.refetch();
    } catch (e) {
      setMsg({ kind: "danger", text: errorMessage(e, t) });
    }
  };
  return (
    <Screen title={t("support.title")}>
      <div className="stack-l">
        <Segmented label={t("support.kind")} value={kind} onChange={setKind} options={[{ value: "support", label: t("support.general") }, { value: "paysupport", label: t("support.payment") }, { value: "content_error", label: t("support.contentError") }]} />
        <Field label={t("support.message")} hint={kind === "paysupport" ? t("bot.paysupport") : t("support.hint")}>{(id) => <textarea id={id} className="textarea" rows={5} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />}</Field>
        <button className="btn btn-primary btn-block" disabled={body.trim().length < 5} onClick={send}>{t("common.send")}</button>
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <section className="stack">
          <h2 className="section-title">{t("support.myTickets")}</h2>
          {list.isLoading ? <Loading lines={1} /> : !list.data?.items.length ? <p className="caption">{t("support.none")}</p> : list.data.items.map((x) => (
            <article key={x.id} className="card stack">
              <div className="row between"><span className="caption">#{x.id} · {new Date(x.created_at).toLocaleString()}</span><Badge kind={x.status === "resolved" ? "success" : "neutral"}>{t(`support.status_${x.status}` as never)}</Badge></div>
              <p className="small break">{x.body}</p>
              {x.resolution && <div className="evidence"><p className="small break">{x.resolution}</p></div>}
            </article>
          ))}
        </section>
      </div>
    </Screen>
  );
}
