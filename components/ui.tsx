import type { ReactNode } from 'react';
import { blockBar } from '@/lib/format';

/* ------------------------------------------------------------------ paineis */

export function Panel({
  title,
  right,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-2 border-b border-phos/25 px-3 py-2">
          <h2 className="panel-title truncate">{title}</h2>
          {right && <div className="shrink-0 text-[0.65rem] dim">{right}</div>}
        </header>
      )}
      <div className={`p-3 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ leitura */

export function Stat({
  label,
  value,
  sub,
  tone = 'normal',
  size = 'md',
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'normal' | 'crit' | 'warn';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  hint?: string;
}) {
  const sizes = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-3xl',
    xl: 'text-4xl sm:text-5xl',
  } as const;
  const toneClass = tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'hot';
  return (
    <div title={hint} className="min-w-0">
      <div className="panel-title truncate">{label}</div>
      <div className={`${sizes[size]} ${toneClass} font-display leading-none mt-1 truncate`}>{value}</div>
      {sub && <div className="mt-1 text-[0.68rem] dim truncate">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ medidor radial */

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/**
 * Ponteiro analogico de 270 graus, no estilo dos instrumentos de bancada.
 * `value` e `max` na mesma unidade; a faixa vermelha comeca em `redline`.
 */
export function Gauge({
  value,
  max,
  label,
  readout,
  unit,
  redline,
  size = 190,
  ticks = 10,
}: {
  value: number;
  max: number;
  label: string;
  readout: string;
  unit?: string;
  redline?: number;
  size?: number;
  ticks?: number;
}) {
  const START = -135;
  const END = 135;
  const SPAN = END - START;
  const cx = 100;
  const cy = 100;
  const r = 78;
  const ratio = max > 0 ? Math.max(0, Math.min(1.02, value / max)) : 0;
  const angle = START + ratio * SPAN;
  const redAngle = redline !== undefined && max > 0 ? START + (redline / max) * SPAN : null;
  const needle = polar(cx, cy, r - 12, angle);
  const tail = polar(cx, cy, -12, angle);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 178" width={size} height={size * 0.89} className="overflow-visible">
        {/* escala de fundo */}
        <path d={arcPath(cx, cy, r, START, END)} fill="none" stroke="rgb(var(--phos) / 0.18)" strokeWidth={9} />
        {/* faixa de atencao */}
        {redAngle !== null && redAngle < END && (
          <path d={arcPath(cx, cy, r, redAngle, END)} fill="none" stroke="rgb(var(--warn) / 0.45)" strokeWidth={9} />
        )}
        {/* valor */}
        <path
          d={arcPath(cx, cy, r, START, angle)}
          fill="none"
          stroke="rgb(var(--phos))"
          strokeWidth={9}
          strokeLinecap="butt"
          style={{ filter: 'drop-shadow(0 0 5px rgb(var(--phos) / 0.85))' }}
        />
        {/* marcacoes */}
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const a = START + (i / ticks) * SPAN;
          const major = i % 2 === 0;
          const p1 = polar(cx, cy, r - 7, a);
          const p2 = polar(cx, cy, r - (major ? 16 : 12), a);
          return (
            <line
              key={i}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke={`rgb(var(--phos) / ${major ? 0.75 : 0.4})`}
              strokeWidth={major ? 1.6 : 1}
            />
          );
        })}
        {/* ponteiro */}
        <line
          x1={tail.x}
          y1={tail.y}
          x2={needle.x}
          y2={needle.y}
          stroke="rgb(var(--phos-hot))"
          strokeWidth={2.4}
          strokeLinecap="round"
          style={{ filter: 'drop-shadow(0 0 4px rgb(var(--phos) / 0.9))' }}
        />
        <circle cx={cx} cy={cy} r={5} fill="rgb(var(--bg))" stroke="rgb(var(--phos))" strokeWidth={1.6} />
        {/* leitura digital */}
        <text x={cx} y={cy + 42} textAnchor="middle" className="font-display" fill="rgb(var(--phos-hot))" fontSize={26}>
          {readout}
        </text>
        {unit && (
          <text x={cx} y={cy + 58} textAnchor="middle" fill="rgb(var(--phos) / 0.6)" fontSize={10} letterSpacing="2">
            {unit}
          </text>
        )}
      </svg>
      <div className="panel-title mt-1 text-center">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ barras */

/** Barra segmentada estilo VU meter. */
export function Meter({
  ratio,
  segments = 24,
  tone = 'normal',
  height = 10,
}: {
  ratio: number;
  segments?: number;
  tone?: 'normal' | 'crit' | 'warn';
  height?: number;
}) {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const on = Math.round(r * segments);
  const color = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn)' : 'var(--phos)';
  return (
    <div className="flex gap-[2px]" style={{ height }} aria-hidden>
      {Array.from({ length: segments }, (_, i) => (
        <div
          key={i}
          className="flex-1"
          style={{
            background: i < on ? `rgb(${color})` : 'rgb(var(--phos) / 0.13)',
            boxShadow: i < on ? `0 0 5px rgb(${color} / 0.6)` : undefined,
          }}
        />
      ))}
    </div>
  );
}

/** Barra em caracteres, para o clima de terminal. */
export function AsciiBar({ ratio, width = 20, className = '' }: { ratio: number; width?: number; className?: string }) {
  return <span className={`blocks ${className}`}>{blockBar(ratio, width)}</span>;
}

export function LabeledBar({
  label,
  ratio,
  value,
  tone = 'normal',
}: {
  label: string;
  ratio: number;
  value: string;
  tone?: 'normal' | 'crit' | 'warn';
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[0.7rem]">
        <span className="dim truncate">{label}</span>
        <span className={tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'hot'}>{value}</span>
      </div>
      <div className="mt-1">
        <Meter ratio={ratio} tone={tone} segments={20} height={8} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sparkline */

export function Sparkline({
  points,
  width = 120,
  height = 30,
  reference,
}: {
  points: { t: number; h: number }[];
  width?: number;
  height?: number;
  /** linha tracejada horizontal, ex.: hashrate nominal */
  reference?: number;
}) {
  if (points.length < 2) {
    return (
      <div className="dimmer text-[0.6rem] flex items-center" style={{ width, height }}>
        coletando…
      </div>
    );
  }
  const values = points.map((p) => p.h);
  const max = Math.max(...values, reference ?? 0) * 1.08 || 1;
  const min = 0;
  const dx = width / (points.length - 1);
  const y = (v: number) => height - ((v - min) / (max - min)) * height;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * dx).toFixed(1)} ${y(p.h).toFixed(1)}`).join(' ');
  const area = `${d} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={area} fill="rgb(var(--phos) / 0.12)" />
      {reference !== undefined && (
        <line
          x1={0}
          y1={y(reference)}
          x2={width}
          y2={y(reference)}
          stroke="rgb(var(--phos) / 0.35)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke="rgb(var(--phos))"
        strokeWidth={1.4}
        style={{ filter: 'drop-shadow(0 0 3px rgb(var(--phos) / 0.7))' }}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ diversos */

export function Led({ state }: { state: 'online' | 'recovering' | 'degraded' | 'offline' }) {
  const map = {
    online: { color: 'var(--phos)', cls: '' },
    // Recuperando pisca devagar: ja produz, mas a media ainda esta subindo.
    recovering: { color: 'var(--phos)', cls: 'blink-crit' },
    degraded: { color: 'var(--warn)', cls: '' },
    offline: { color: 'var(--crit)', cls: 'blink-crit' },
  } as const;
  const { color, cls } = map[state];
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${cls}`}
      style={{ background: `rgb(${color})`, boxShadow: `0 0 7px rgb(${color} / 0.9)` }}
      aria-label={state}
    />
  );
}

export function KeyValue({ k, v, tone }: { k: string; v: ReactNode; tone?: 'crit' | 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[0.78rem]">
      <span className="dim truncate">{k}</span>
      <span className={`shrink-0 ${tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'hot'}`}>{v}</span>
    </div>
  );
}

export function Divider({ label }: { label?: string }) {
  return (
    <div className="my-3 flex items-center gap-2">
      <div className="h-px flex-1 bg-phos/20" />
      {label && <span className="panel-title">{label}</span>}
      <div className="h-px flex-1 bg-phos/20" />
    </div>
  );
}
