import { useEffect, useRef, type ReactNode } from "react";
import { X, Loader2, Info } from "lucide-react";
import { initials } from "./format";

export function Drawer({ open, onClose, title, subtitle, actions, children, width = 560 }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="crm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="crm-drawer" style={{ width: `min(${width}px, 100vw)` }} role="dialog" aria-modal="true">
        <header className="crm-drawer-head">
          <div className="crm-drawer-title">
            <h2>{title}</h2>
            {subtitle && <div className="crm-drawer-sub">{subtitle}</div>}
          </div>
          <div className="crm-drawer-actions">
            {actions}
            <button type="button" className="crm-icon-btn" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
          </div>
        </header>
        <div className="crm-drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // foca o primeiro campo, mas nunca rouba o foco de quem já clicou/digitou em outro campo do modal
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="crm-overlay center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="crm-modal" style={{ width: `min(${width}px, calc(100vw - 24px))` }} role="dialog" aria-modal="true" ref={ref}>
        <header className="crm-modal-head">
          <h3>{title}</h3>
          <button type="button" className="crm-icon-btn" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </header>
        <div className="crm-modal-body">{children}</div>
        {footer && <footer className="crm-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Avatar({ name, size = 28, tone }: { name: string | null | undefined; size?: number; tone?: string }) {
  const text = initials(name);
  const hue = [...(name ?? "?")].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span className="crm-avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: tone ?? `hsl(${hue} 30% 92%)`, color: `hsl(${hue} 35% 30%)` }} title={name ?? ""}>
      {text}
    </span>
  );
}

export function Pill({ children, tone = "muted", title }: { children: ReactNode; tone?: string; title?: string }) {
  return <span className={`crm-pill tone-${tone}`} title={title}>{children}</span>;
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="crm-empty">
      {icon && <div className="crm-empty-icon">{icon}</div>}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="crm-spinner"><Loader2 size={18} className="spin" /> {label ?? "Carregando…"}</div>;
}

export function Skeleton({ rows = 4, height = 46 }: { rows?: number; height?: number }) {
  return (
    <div className="crm-skeleton-list">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="crm-skeleton" style={{ height }} />)}
    </div>
  );
}

export function Field({ label, children, hint, span }: { label: string; children: ReactNode; hint?: string; span?: 1 | 2 }) {
  return (
    <label className={`crm-field${span === 2 ? " span-2" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: {
  value: T; options: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; size?: "sm" | "md";
}) {
  return (
    <div className={`crm-segmented ${size}`} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}{o.count !== undefined && <em>{o.count}</em>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, tone, hint, onClick, unavailable }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: string; hint?: string; onClick?: () => void; unavailable?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} className={`crm-stat${tone ? ` tone-${tone}` : ""}${onClick ? " clickable" : ""}`} onClick={onClick} title={hint}>
      <span className="crm-stat-label">{label}{hint && <Info size={12} />}</span>
      {unavailable ? <span className="crm-stat-na">{unavailable}</span> : <strong>{value}</strong>}
      {sub && <span className="crm-stat-sub">{sub}</span>}
    </Tag>
  );
}

export function Confirm({ open, title, text, confirmLabel = "Confirmar", danger, onConfirm, onClose }: {
  open: boolean; title: string; text: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={420}
      footer={<>
        <button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className={`crm-btn ${danger ? "danger" : "primary"}`} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
      </>}>
      <p className="crm-muted">{text}</p>
    </Modal>
  );
}

export function Bar({ value, max, tone = "ink" }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return <span className={`crm-bar tone-${tone}`}><i style={{ width: `${w}%` }} /></span>;
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <nav className="crm-tabs">
      {tabs.map((t) => (
        <button key={t.value} type="button" className={value === t.value ? "on" : ""} onClick={() => onChange(t.value)}>
          {t.label}{t.count ? <em>{t.count}</em> : null}
        </button>
      ))}
    </nav>
  );
}
