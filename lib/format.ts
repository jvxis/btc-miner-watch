// Formatadores usados pelo servidor e pelo cliente.

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const fmtBrl = (v: number, compact = false): string =>
  !Number.isFinite(v) ? '—' : compact ? brl0.format(v) : brl.format(v);

export const fmtUsd = (v: number, compact = false): string =>
  !Number.isFinite(v) ? '—' : compact ? usd0.format(v) : usd.format(v);

export const fmtMoney = (v: number, cur: 'BRL' | 'USD', compact = false): string =>
  cur === 'BRL' ? fmtBrl(v, compact) : fmtUsd(v, compact);

/** Hashrate em TH/s formatado na maior unidade legivel. */
export function fmtHash(th: number, digits = 2): string {
  if (!Number.isFinite(th)) return '—';
  if (th >= 1e6) return `${(th / 1e6).toFixed(digits)} EH/s`;
  if (th >= 1000) return `${(th / 1000).toFixed(digits)} PH/s`;
  if (th >= 1) return `${th.toFixed(digits)} TH/s`;
  return `${(th * 1000).toFixed(0)} GH/s`;
}

/** Hashrate da rede vem em H/s. */
export function fmtHashHs(hs: number | null, digits = 2): string {
  if (hs === null || !Number.isFinite(hs)) return '—';
  return fmtHash(hs / 1e12, digits);
}

export const fmtBtc = (v: number, digits = 8): string =>
  Number.isFinite(v) ? `${v.toFixed(digits)}` : '—';

export const fmtSats = (btc: number): string =>
  Number.isFinite(btc) ? `${Math.round(btc * 1e8).toLocaleString('pt-BR')} sats` : '—';

export const fmtPct = (v: number, digits = 1): string =>
  Number.isFinite(v) ? `${v.toFixed(digits)}%` : '—';

export const fmtNum = (v: number, digits = 0): string =>
  Number.isFinite(v) ? v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';

/** Duracao curta: 3d 4h, 2h 15m, 45s */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const fmtClock = (ts: number): string =>
  ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export const fmtDateTime = (ts: number): string =>
  ts ? new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export const fmtDate = (ts: number): string =>
  ts ? new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';

/** Barra de blocos ASCII, ex.: ████████░░░░ */
export function blockBar(ratio: number, width = 20, full = '█', empty = '░'): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(r * width);
  return full.repeat(filled) + empty.repeat(width - filled);
}
