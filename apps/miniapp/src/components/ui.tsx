import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { MessageKey } from "@talaba/shared";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { ApiError } from "../lib/api";
import { tg } from "../lib/telegram";

export function Screen({ title, back = true, actions, children }: { title: string; back?: boolean; actions?: ReactNode; children: ReactNode }) {
  const navigate = useNavigate();
  const t = useT();
  useEffect(() => {
    const w = tg();
    if (!w || !w.isVersionAtLeast("6.1")) return;
    const onBack = () => navigate(-1);
    if (back) {
      w.BackButton.show();
      w.BackButton.onClick(onBack);
    } else w.BackButton.hide();
    return () => w.BackButton.offClick(onBack);
  }, [back, navigate]);
  return (
    <>
      <header className="screen-head">
        {back && !tg()?.initData && (
          <button className="back-btn" onClick={() => navigate(-1)} aria-label={t("common.back")}>
            ←
          </button>
        )}
        <h1 className="grow break">{title}</h1>
        {actions}
      </header>
      {children}
    </>
  );
}

export function Loading({ lines = 3 }: { lines?: number }) {
  const t = useT();
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 ? 72 : 56 }} />
      ))}
    </div>
  );
}

export function Empty({ icon = "📭", text, action }: { icon?: string; text: string; action?: ReactNode }) {
  return (
    <div className="state card flat">
      <div className="state-icon" aria-hidden>
        {icon}
      </div>
      <p className="muted">{text}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const forbidden = error instanceof ApiError && (error.status === 403 || error.status === 404);
  return (
    <div className="state card flat" role="alert">
      <div className="state-icon" aria-hidden>
        {forbidden ? "🔒" : "⚠️"}
      </div>
      <p>{forbidden ? (error.status === 404 ? t("common.notFound") : t("common.forbidden")) : errorMessage(error, t)}</p>
      {onRetry && !forbidden && (
        <button className="btn btn-secondary" onClick={onRetry}>
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

export function Banner({ kind = "info", children }: { kind?: "info" | "warn" | "danger" | "success"; children: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "danger" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Badge({ kind = "neutral", children }: { kind?: "neutral" | "primary" | "success" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div>
      <div className="toggle-row">
        <label htmlFor={id} className="grow">
          {label}
        </label>
        <span className="switch">
          <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          <span aria-hidden />
        </span>
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="row between" style={{ marginBottom: 16, alignItems: "flex-start" }}>
          <h2 className="break">{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ActionBar({ children, overNav = false }: { children: ReactNode; overNav?: boolean }) {
  return (
    <div className={`action-bar${overNav ? " over-nav" : ""}`}>
      <div className="inner">{children}</div>
    </div>
  );
}

export function SaveState({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  const t = useT();
  if (state === "idle") return null;
  const map: Record<string, [string, MessageKey]> = { saving: ["⏳", "common.saving"], saved: ["✓", "common.saved"], error: ["⚠️", "common.notSaved"] };
  const [icon, key] = map[state]!;
  return (
    <span className={`caption`} role="status" aria-live="polite">
      {icon} {t(key)}
    </span>
  );
}

let toastSetter: ((m: string | null) => void) | null = null;
export function toast(message: string) {
  toastSetter?.(message);
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return (
    <div className="toast-wrap" aria-live="polite">
      <div className="toast">{msg}</div>
    </div>
  );
}

export function JobProgress({ status, done, total, onCancel }: { status: string; done: number; total: number; onCancel?: () => void }) {
  const t = useT();
  const label = (s: string) => t(`jobs.${s}` as MessageKey);
  return (
    <div className="card stack" aria-live="polite">
      <div className="row">
        {status !== "completed" && status !== "failed" && status !== "cancelled" && <div className="spinner" aria-hidden />}
        <strong className="grow">{label(status)}</strong>
        <span className="caption">{t("jobs.stage", { done: Math.min(done + (status === "completed" ? 0 : 1), total), total })}</span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <p className="caption">{t("jobs.keepsRunning")}</p>
      {onCancel && (
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>
          {t("jobs.cancel")}
        </button>
      )}
    </div>
  );
}
