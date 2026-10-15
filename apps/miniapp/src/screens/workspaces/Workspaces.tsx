import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useMe } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { haptic, shareToTelegram, tg } from "../../lib/telegram";
import { Badge, Banner, Empty, ErrorState, Field, Loading, Screen, Segmented, Sheet, toast } from "../../components/ui";

type Role = "owner" | "editor" | "viewer";
type Member = { user_id: string; name: string; role: Role };
type Task = { id: string; title: string; description: string | null; status: string; due_at: string | null; assignee_id: string | null; assignee_name: string | null };
type Event = { id: string; type: string; actor: string | null; at: string; data: Record<string, unknown> };
type Invite = { id: string; role: string; expires_at: string; revoked_at: string | null; uses: number };
type Ws = {
  id: string; name: string; role: Role; members: Member[]; tasks: Task[]; events: Event[]; invites: Invite[];
  documents: { id: string; title: string }[]; quizzes: { id: string; title: string; published: boolean }[]; decks: { id: string; title: string; status: string }[];
};

export function WorkspaceNew() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ workspaceId: string }>("/api/workspaces", { name });
      await qc.invalidateQueries({ queryKey: ["workspaces"] });
      navigate(`/workspaces/${r.workspaceId}`, { replace: true });
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t("group.newWorkspace")}>
      <div className="stack">
        <p className="caption">{t("ws.newHint")}</p>
        <Field label={t("ws.name")}>{(id) => <input id={id} className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field>
        {err && <Banner kind="danger">{err}</Banner>}
        <button className="btn btn-primary btn-block" disabled={busy || !name.trim()} onClick={submit}>{t("ws.create")}</button>
      </div>
    </Screen>
  );
}

/** Opened from t.me/<bot>?startapp=w<token>: joins with the invite's role, then shows the workspace. */
export function WorkspaceJoin() {
  const { token } = useParams();
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    api.post<{ workspaceId: string }>("/api/workspaces/join", { token })
      .then(async (r) => { await qc.invalidateQueries({ queryKey: ["workspaces"] }); navigate(`/workspaces/${r.workspaceId}`, { replace: true }); })
      .catch((e) => setErr(errorMessage(e, t)));
  }, [token, navigate, qc, t]);
  return (
    <Screen title={t("ws.joining")}>
      {err ? <Banner kind="danger">{err}</Banner> : <Loading lines={2} />}
    </Screen>
  );
}

export function WorkspaceDetail() {
  const { id } = useParams();
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["workspace", id], queryFn: () => api.get<Ws>(`/api/workspaces/${id}`) });
  const [tab, setTab] = useState<"materials" | "tasks" | "members" | "activity">("materials");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  if (ws.isLoading) return <Screen title={t("group.workspaces")}><Loading /></Screen>;
  if (ws.isError) return <Screen title={t("group.workspaces")}><ErrorState error={ws.error} onRetry={() => ws.refetch()} /></Screen>;
  const w = ws.data!;
  const refresh = () => qc.invalidateQueries({ queryKey: ["workspace", id] });
  const canEdit = w.role !== "viewer";
  const roleLabel = (r: string) => t(r === "owner" ? "group.roleOwner" : r === "editor" ? "group.roleEditor" : "group.roleViewer");
  const setStatus = async (task: Task, done: boolean) => {
    const status = done ? "done" : "todo";
    // optimistic: the checkbox flips at once, the server result replaces it
    setLocal((m) => ({ ...m, [task.id]: status }));
    try {
      await api.patch(`/api/tasks/${task.id}`, { status });
    } catch (e) {
      toast(errorMessage(e, t));
    } finally {
      await refresh();
      setLocal((m) => {
        const next = { ...m };
        delete next[task.id];
        return next;
      });
    }
  };
  const statusOf = (task: Task) => local[task.id] ?? task.status;
  return (
    <Screen title={w.name} actions={w.role === "owner" ? <button className="btn btn-primary btn-sm" onClick={() => setInviteOpen(true)}>+ {t("ws.invite")}</button> : undefined}>
      <div className="stack-l">
        <div className="row wrap"><Badge kind="primary">{roleLabel(w.role)}</Badge><span className="caption">{t("ws.membersN", { n: w.members.length })}</span></div>
        <Segmented label={t("ws.sections")} value={tab} onChange={setTab} options={[
          { value: "materials", label: t("ws.materials") },
          { value: "tasks", label: t("ws.tasks") },
          { value: "members", label: t("ws.members") },
          { value: "activity", label: t("ws.activity") },
        ]} />

        {tab === "materials" && (
          <div className="stack">
            {!w.documents.length && !w.quizzes.length && !w.decks.length && <Empty icon="📂" text={t("ws.noMaterials")} />}
            {w.documents.length > 0 && <h2 className="section-title">{t("library.title")}</h2>}
            <div className="list">{w.documents.map((d) => <Link key={d.id} to={`/library/${d.id}`} className="list-item"><span aria-hidden>📄</span><span className="grow break">{d.title}</span><span className="chev">›</span></Link>)}</div>
            {w.quizzes.length > 0 && <h2 className="section-title">{t("create.myQuizzes")}</h2>}
            <div className="list">{w.quizzes.map((q) => <Link key={q.id} to={`/quiz/${q.id}/edit`} className="list-item"><span aria-hidden>📝</span><span className="grow break">{q.title}</span>{q.published && <Badge kind="success">{t("quiz.published")}</Badge>}</Link>)}</div>
            {w.decks.length > 0 && <h2 className="section-title">{t("deck.title")}</h2>}
            <div className="list">{w.decks.map((d) => <Link key={d.id} to={`/decks/${d.id}`} className="list-item"><span aria-hidden>📊</span><span className="grow break">{d.title}</span><span className="chev">›</span></Link>)}</div>
            {canEdit && <p className="caption">{t("ws.addHint")}</p>}
          </div>
        )}

        {tab === "tasks" && (
          <div className="stack">
            {canEdit && <button className="btn btn-secondary" onClick={() => setTaskOpen(true)}>+ {t("ws.newTask")}</button>}
            {!w.tasks.length ? <Empty icon="✅" text={t("ws.noTasks")} /> : (
              <div className="list">
                {w.tasks.map((task) => {
                  const mine = task.assignee_id === me.user.id;
                  return (
                    <div key={task.id} className="list-item">
                      <input type="checkbox" style={{ width: 22, height: 22 }} checked={statusOf(task) === "done"} disabled={!canEdit && !mine} onChange={(e) => setStatus(task, e.target.checked)} aria-label={task.title} />
                      <button className="grow" style={{ all: "unset", cursor: "pointer", flex: 1 }} onClick={() => setOpenTask(task)}>
                        <div className="break" style={{ textDecoration: statusOf(task) === "done" ? "line-through" : undefined }}>{task.title}</div>
                        <div className="meta">{task.assignee_name || t("ws.unassigned")}{task.due_at ? ` · ${new Date(task.due_at).toLocaleDateString()}` : ""}</div>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "members" && (
          <div className="list">
            {w.members.map((m) => (
              <div key={m.user_id} className="list-item">
                <span aria-hidden>👤</span>
                <span className="grow break">{m.name}{m.user_id === me.user.id ? ` (${t("ws.you")})` : ""}</span>
                {w.role === "owner" && m.user_id !== me.user.id ? (
                  <select className="input" style={{ width: "auto" }} aria-label={t("ws.roleOf", { name: m.name })} value={m.role} onChange={async (e) => {
                    const role = e.target.value === "remove" ? null : e.target.value;
                    try { await api.put(`/api/workspaces/${id}/members/${m.user_id}`, { role }); await refresh(); } catch (err) { toast(errorMessage(err, t)); }
                  }}>
                    <option value="owner">{roleLabel("owner")}</option>
                    <option value="editor">{roleLabel("editor")}</option>
                    <option value="viewer">{roleLabel("viewer")}</option>
                    <option value="remove">{t("ws.remove")}</option>
                  </select>
                ) : <Badge kind="neutral">{roleLabel(m.role)}</Badge>}
              </div>
            ))}
            {w.role === "owner" && w.invites.length > 0 && (
              <section className="stack" style={{ marginTop: 16 }}>
                <h2 className="section-title">{t("ws.invites")}</h2>
                {w.invites.map((inv) => {
                  const active = !inv.revoked_at && new Date(inv.expires_at) > new Date();
                  return (
                    <div key={inv.id} className="list-item">
                      <div className="grow">
                        <div>{roleLabel(inv.role)} · {t("ws.uses", { n: inv.uses })}</div>
                        <div className="meta">{active ? t("ws.until", { date: new Date(inv.expires_at).toLocaleString() }) : t("ws.inviteInactive")}</div>
                      </div>
                      {active && <button className="btn btn-ghost btn-sm" onClick={async () => { await api.del(`/api/workspaces/${id}/invites/${inv.id}`); await refresh(); }}>{t("ws.revoke")}</button>}
                    </div>
                  );
                })}
              </section>
            )}
          </div>
        )}

        {tab === "activity" && (
          <div className="list">
            {w.events.map((e) => (
              <div key={e.id} className="list-item">
                <div className="grow">
                  <div className="small">{e.actor ?? "—"} · {t(`wsEvent.${e.type.replace(".", "_")}` as never, { title: String(e.data?.title ?? ""), role: e.data?.role ? roleLabel(String(e.data.role)) : "" })}</div>
                  <div className="meta">{new Date(e.at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <InviteSheet open={inviteOpen} onClose={() => { setInviteOpen(false); refresh(); }} workspaceId={w.id} name={w.name} />
      <TaskSheet open={taskOpen} onClose={() => setTaskOpen(false)} workspaceId={w.id} members={w.members} onSaved={refresh} />
      <TaskComments task={openTask} onClose={() => setOpenTask(null)} />
    </Screen>
  );
}

function InviteSheet({ open, onClose, workspaceId, name }: { open: boolean; onClose: () => void; workspaceId: string; name: string }) {
  const t = useT();
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setErr(null);
    try {
      const r = await api.post<{ link: string | null; startParam: string }>(`/api/workspaces/${workspaceId}/invites`, { role, ttlHours: 72 });
      setLink(r.link);
      if (!r.link) setErr(t("ws.linkNeedsBot"));
      haptic("success");
    } catch (e) {
      setErr(errorMessage(e, t));
    }
  };
  return (
    <Sheet open={open} onClose={() => { setLink(null); onClose(); }} title={t("ws.invite")}>
      <div className="stack">
        <Segmented label={t("ws.inviteRole")} value={role} onChange={(r) => { setRole(r); setLink(null); }} options={[{ value: "editor", label: t("group.roleEditor") }, { value: "viewer", label: t("group.roleViewer") }]} />
        <p className="caption">{role === "editor" ? t("ws.editorHint") : t("ws.viewerHint")} {t("ws.inviteTtl")}</p>
        {!link ? <button className="btn btn-primary btn-block" onClick={create}>{t("ws.createLink")}</button> : (
          <>
            <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t("ws.link")} />
            <div className="row">
              <button className="btn btn-primary grow" onClick={() => shareToTelegram(link, t("ws.shareText", { name }))}>{t("common.share")}</button>
              <button className="btn btn-secondary" onClick={async () => { await navigator.clipboard?.writeText(link).catch(() => {}); toast(t("common.copied")); }}>{t("common.copy")}</button>
            </div>
          </>
        )}
        {err && <Banner kind="warn">{err}</Banner>}
      </div>
    </Sheet>
  );
}

function TaskSheet({ open, onClose, workspaceId, members, onSaved }: { open: boolean; onClose: () => void; workspaceId: string; members: Member[]; onSaved: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      await api.post(`/api/workspaces/${workspaceId}/tasks`, { title, assigneeId: assignee || null, dueAt: due ? new Date(`${due}T20:00:00`).toISOString() : null });
      setTitle(""); setAssignee(""); setDue("");
      onSaved();
      onClose();
    } catch (e) {
      setErr(errorMessage(e, t));
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={t("ws.newTask")}>
      <div className="stack">
        <Field label={t("ws.taskTitle")}>{(id) => <input id={id} className="input" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t("ws.assignee")}>{(id) => (
          <select id={id} className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t("ws.unassigned")}</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
          </select>
        )}</Field>
        <Field label={t("ws.due")}>{(id) => <input id={id} className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        {err && <Banner kind="danger">{err}</Banner>}
        <button className="btn btn-primary btn-block" disabled={!title.trim()} onClick={save}>{t("common.save")}</button>
      </div>
    </Sheet>
  );
}

type Comment = { id: string; body: string; created_at: string; author_id: string; author: string };

function TaskComments({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["comments", task?.id], enabled: !!task, queryFn: () => api.get<{ items: Comment[] }>(`/api/comments?targetType=task&targetId=${task!.id}`) });
  const [body, setBody] = useState("");
  const send = async () => {
    try {
      await api.post("/api/comments", { targetType: "task", targetId: task!.id, body });
      setBody("");
      await qc.invalidateQueries({ queryKey: ["comments", task!.id] });
    } catch (e) {
      toast(errorMessage(e, t));
    }
  };
  return (
    <Sheet open={!!task} onClose={onClose} title={task?.title ?? ""}>
      <div className="stack">
        {task?.description && <p className="break">{task.description}</p>}
        <h3 className="section-title">{t("ws.comments")}</h3>
        {list.isLoading ? <Loading lines={2} /> : !list.data?.items.length ? <p className="caption">{t("ws.noComments")}</p> : (
          <div className="stack">
            {list.data.items.map((c) => (
              <div key={c.id} className="evidence">
                <div className="row between"><span className="caption">{c.author} · {new Date(c.created_at).toLocaleString()}</span>
                  {c.author_id === me.user.id && <button className="btn btn-ghost btn-sm" aria-label={t("common.delete")} onClick={async () => { await api.del(`/api/comments/${c.id}`); await qc.invalidateQueries({ queryKey: ["comments", task!.id] }); }}>✕</button>}
                </div>
                <p className="small break">{c.body}</p>
              </div>
            ))}
          </div>
        )}
        <textarea className="textarea" rows={2} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} aria-label={t("ws.addComment")} placeholder={t("ws.addComment")} />
        <button className="btn btn-secondary" disabled={!body.trim()} onClick={send}>{t("common.send")}</button>
      </div>
    </Sheet>
  );
}

/** “Move to group”: hands an owned item (document / quiz / deck) to a workspace the user edits. */
export function MoveToWorkspace({ kind, id, onDone }: { kind: "document" | "quiz" | "deck"; id: string; onDone?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ws = useQuery({ queryKey: ["workspaces"], enabled: open, queryFn: () => api.get<{ items: { id: string; name: string; role: string; kind?: string }[] }>("/api/workspaces") });
  const move = async (workspaceId: string) => {
    const ok = await new Promise<boolean>((res) => (tg()?.showConfirm ? tg()!.showConfirm!(t("ws.moveConfirm"), res) : res(window.confirm(t("ws.moveConfirm")))));
    if (!ok) return;
    try {
      await api.post("/api/share/move", { kind, id, workspaceId });
      toast(t("common.done"));
      setOpen(false);
      onDone?.();
    } catch (e) {
      toast(errorMessage(e, t));
    }
  };
  const targets = (ws.data?.items ?? []).filter((w) => w.role === "owner" || w.role === "editor").filter((w) => w.kind !== "personal");
  return (
    <>
      <button className="btn btn-secondary" onClick={() => setOpen(true)}>👥 {t("ws.moveToGroup")}</button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t("ws.moveToGroup")}>
        {ws.isLoading ? <Loading lines={2} /> : !targets.length ? (
          <Empty icon="👥" text={t("group.noWorkspaces")} action={<Link className="btn btn-primary" to="/workspaces/new">{t("group.newWorkspace")}</Link>} />
        ) : (
          <div className="list">{targets.map((w) => <button key={w.id} className="list-item" onClick={() => move(w.id)}><span aria-hidden>👥</span><span className="grow break">{w.name}</span></button>)}</div>
        )}
      </Sheet>
    </>
  );
}
