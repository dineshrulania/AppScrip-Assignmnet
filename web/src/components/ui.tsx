import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { IncidentStatus, Severity } from '../types';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

let now = Date.now();
const tickers = new Set<() => void>();
setInterval(() => {
  now = Date.now();
  tickers.forEach((t) => t());
}, 1000);

/** Current time, re-rendering once a second - keeps "12s ago" labels honest. */
export const useNow = () =>
  useSyncExternalStore(
    (l) => (tickers.add(l), () => tickers.delete(l)),
    () => now,
  );

export function ago(ts: number | null | undefined, at = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((at - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s ` : ''}ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dur(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const clock = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';

export const dateTime = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';

export function Ago({ ts }: { ts: number | null | undefined }) {
  const n = useNow();
  return <span title={dateTime(ts)}>{ago(ts, n)}</span>;
}

export const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function Badge({ tone = 'muted', dot, children, title }: { tone?: string; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`badge b-${tone}`} title={title}>
      {dot && <span className="d" />}
      {children}
    </span>
  );
}

export const SevBadge = ({ s }: { s: Severity }) => <span className={`badge sev sev-${s}`}>{s}</span>;

export const sevColor = (s: Severity) => `var(--sev-${s})`;

export function StatusBadge({ s }: { s: IncidentStatus }) {
  const tone = s === 'open' ? 'danger' : s === 'acknowledged' ? 'warn' : 'ok';
  return <Badge tone={tone} dot>{s === 'acknowledged' ? 'Acknowledged' : s === 'open' ? 'Open' : 'Resolved'}</Badge>;
}

export function DeviceStatus({ s }: { s: string }) {
  return <Badge tone={s === 'online' ? 'ok' : s === 'offline' ? 'danger' : 'muted'} dot>{s}</Badge>;
}

export function EventStatus({ s }: { s: string }) {
  const tone = s === 'processed' ? 'ok' : s === 'failed' ? 'danger' : s === 'processing' ? 'info' : 'warn';
  return <Badge tone={tone}>{s}</Badge>;
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Panel({ title, hint, right, children, flush, className = '' }: {
  title?: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean; className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <div className="panel-head">
          <h3>{title}</h3>
          {hint && <span className="hint">{hint}</span>}
          {right && <div className="right">{right}</div>}
        </div>
      )}
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Toggle({ on, onChange, disabled, title }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} disabled={disabled} title={title} aria-pressed={on} />;
}

export function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: ReactNode; n?: number }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
          {o.n !== undefined && <span className="n">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ onClose, title, sub, actions, children }: {
  onClose: () => void; title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog">
        <div className="drawer-head">
          <div className="grow">
            <div style={{ fontSize: 17, fontWeight: 650, letterSpacing: '-0.01em' }}>{title}</div>
            {sub && <div className="muted small" style={{ marginTop: 4 }}>{sub}</div>}
          </div>
          {actions}
          <button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

type ToastT = { id: number; kind: 'ok' | 'err' | 'info'; text: string };
let toasts: ToastT[] = [];
const toastListeners = new Set<() => void>();
export function toast(text: string, kind: ToastT['kind'] = 'info') {
  const t = { id: Math.random(), kind, text };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((x) => x !== t);
    toastListeners.forEach((l) => l());
  }, kind === 'err' ? 6000 : 3500);
}
export function Toasts() {
  const list = useSyncExternalStore((l) => (toastListeners.add(l), () => toastListeners.delete(l)), () => toasts);
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'err' ? 'alert' : t.kind === 'ok' ? 'check' : 'info'} size={16} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Wrap an async action: disables while running, toasts the outcome. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

// ---------------------------------------------------------------------------
// Icons (inline, stroke-based)
// ---------------------------------------------------------------------------

const PATHS: Record<string, string> = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  cpu: 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 9h6v6H9z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  server: 'M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 13h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM7 7h.01M7 17h.01',
  flask: 'M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  wifiOff: 'M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.4-1.7M1.4 9a16 16 0 0 1 4.7-2.9M22.6 9A16 16 0 0 0 10.7 5M12 20h.01',
  wifi: 'M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M1.4 9a16 16 0 0 1 21.2 0M12 20h.01',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  play: 'M5 3l14 9-14 9V3z',
  power: 'M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10',
  thermo: 'M14 14.8V3.5a2.5 2.5 0 0 0-5 0v11.3a4.5 4.5 0 1 0 5 0z',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  bug: 'M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 1 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6.5 13H3M21 13h-3.5M6 17l-3 2M18 17l3 2M6 9 3 7M18 9l3-2',
  plus: 'M12 5v14M5 12h14',
  layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  mail: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6',
  map: 'M12 22s-8-6.5-8-12a8 8 0 0 1 16 0c0 5.5-8 12-8 12zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  rewind: 'M11 19 2 12l9-7v14zM22 19l-9-7 9-7v14z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z',
};

export function Icon({ name, size = 16, color, style }: { name: keyof typeof PATHS | string; size?: number; color?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', ...style }} aria-hidden>
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
