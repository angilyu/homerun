import { useEffect, useRef, useState, type ReactNode } from "react";
import { ago, when } from "@homerun/app-state";
import { useNow } from "../hooks";

export function Time({ ts, relative = false }: { ts: number; relative?: boolean }) {
  const now = useNow();
  const exact = new Date(ts).toLocaleString();
  return (
    <time dateTime={new Date(ts).toISOString()} title={exact}>
      {relative ? ago(ts, now) : when(ts, now)}
    </time>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Badge({ tone = "plain", children }: { tone?: "plain" | "warn" | "danger" | "ok" | "info"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** A confirmation step inside the page, instead of a native dialog. */
export function ConfirmButton({ label, confirm, onConfirm, danger = false, disabled = false }: { label: string; confirm: string; onConfirm: () => void; danger?: boolean; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button type="button" className={danger ? "danger" : undefined} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className="confirm" role="group" aria-label={confirm}>
      <span>{confirm}</span>
      <button
        type="button"
        className={danger ? "danger" : "primary"}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {label}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

/** Long text, folded to a few lines until expanded. */
export function Fold({ text, lines = 8, className = "pre" }: { text: string; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 120;
  return (
    <div className="fold">
      <pre className={className} data-folded={long && !open ? "" : undefined} style={long && !open ? { maxHeight: `${lines * 1.4}em` } : undefined}>
        {text}
      </pre>
      {long && (
        <button type="button" className="link" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

export function Page({ title, actions, children, sub }: { title: ReactNode; actions?: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {sub && <p className="sub">{sub}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      <div className="page-body">{children}</div>
    </section>
  );
}

/** Focus an element when it mounts. */
export function useAutofocus<T extends HTMLElement>() {
  const r = useRef<T>(null);
  useEffect(() => r.current?.focus(), []);
  return r;
}
