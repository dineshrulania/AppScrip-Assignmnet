import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { clock } from './ui';

export function Sparkline({ values, color = 'var(--accent)', width = 96, height = 30 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const id = 'sg' + useId().replace(/:/g, '');
  if (values.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} className="spark" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}L${width},${height}L0,${height}Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function niceMax(v: number) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1);
}

interface Series<T> {
  key: keyof T & string;
  label: string;
  color: string;
}

/** Stacked bar chart with crosshair tooltip. */
export function StackedBars<T extends { t: number }>({ data, series, height = 200, format = (n: number) => String(n) }: {
  data: T[]; series: Series<T>[]; height?: number; format?: (n: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = height;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const totals = data.map((d) => series.reduce((a, s) => a + (Number(d[s.key]) || 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => f * max);

  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.floor((x - pad.l) / bw);
    setHover(i >= 0 && i < data.length ? i : null);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t ? '3 4' : undefined} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--muted)">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          let acc = 0;
          return (
            <g key={d.t} opacity={hover === null || hover === i ? 1 : 0.55}>
              {series.map((s) => {
                const v = Number(d[s.key]) || 0;
                if (!v) return null;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return <rect key={s.key} x={pad.l + i * bw + 1} width={Math.max(1, bw - 2)} y={y1} height={Math.max(0.5, y0 - y1)} fill={s.color} rx={1.5} />;
              })}
            </g>
          );
        })}
        {data.filter((_, i) => i % Math.ceil(data.length / 6) === 0).map((d) => {
          const i = data.indexOf(d);
          return <text key={d.t} x={pad.l + i * bw} y={H - 6} fontSize="10.5" fill="var(--muted)">{clock(d.t).slice(0, 5)}</text>;
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="chart-tip" style={{ left: `min(calc(${((pad.l + hover * bw) / W) * 100}% + 12px), calc(100% - 170px))`, top: 8 }}>
          <div className="b600" style={{ marginBottom: 4 }}>{clock(data[hover].t)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex" style={{ justifyContent: 'space-between', gap: 16 }}>
              <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}</span>
              <span className="mono">{format(Number(data[hover][s.key]) || 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>
      ))}
    </div>
  );
}

/** Time-series line with an optional threshold band - used for device readings. */
export function LineChart({ points, threshold, color = 'var(--accent-2)', height = 180, unit = '', label }: {
  points: { t: number; v: number }[]; threshold?: { value: number; op: string } | null; color?: string; height?: number; unit?: string; label?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 10, t: 12, b: 22 };
  const { minV, maxV, t0, t1 } = useMemo(() => {
    const vs = points.map((p) => p.v).concat(threshold ? [threshold.value] : []);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    if (lo === hi) (lo -= 1), (hi += 1);
    const span = hi - lo;
    return { minV: lo - span * 0.1, maxV: hi + span * 0.1, t0: points[0]?.t ?? 0, t1: points.at(-1)?.t ?? 1 };
  }, [points, threshold]);
  if (points.length < 2) return <div className="empty">Not enough readings yet</div>;

  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - minV) / (maxV - minV)) * (H - pad.t - pad.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const above = threshold && (threshold.op.startsWith('>') ? true : false);

  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const tx = t0 + (((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - tx) < Math.abs(points[best].t - tx)) best = i;
    setHover(best);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {label}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
        {[0, 0.5, 1].map((f) => {
          const v = minV + (maxV - minV) * f;
          return (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray="3 4" />
              <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10.5" fill="var(--muted)">{v.toFixed(1)}</text>
            </g>
          );
        })}
        {threshold && (
          <>
            <rect x={pad.l} width={W - pad.l - pad.r} y={above ? pad.t : y(threshold.value)} height={above ? y(threshold.value) - pad.t : H - pad.b - y(threshold.value)} fill="var(--danger)" opacity="0.07" />
            <line x1={pad.l} x2={W - pad.r} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--danger)" strokeDasharray="5 4" strokeWidth="1.3" />
            <text x={W - pad.r - 4} y={y(threshold.value) - 5} textAnchor="end" fontSize="10.5" fill="#ff7b86">threshold {threshold.op} {threshold.value}{unit}</text>
          </>
        )}
        <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
        {hover !== null && <circle cx={x(points[hover].t)} cy={y(points[hover].v)} r="4" fill={color} stroke="var(--bg)" strokeWidth="2" />}
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={pad.l + f * (W - pad.l - pad.r)} y={H - 5} fontSize="10.5" fill="var(--muted)" textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>
            {clock(t0 + f * (t1 - t0)).slice(0, 5)}
          </text>
        ))}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `min(calc(${(x(points[hover].t) / W) * 100}% + 12px), calc(100% - 160px))`, top: 10 }}>
          <div className="muted small">{clock(points[hover].t)}</div>
          <div className="b600" style={{ fontSize: 15 }}>{points[hover].v}{unit}</div>
        </div>
      )}
    </div>
  );
}
