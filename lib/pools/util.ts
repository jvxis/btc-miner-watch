export const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
};

/** H/s -> TH/s */
export const toTh = (v: string | number | null | undefined): number => num(v) / 1e12;

const UNIDADE: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/**
 * Hashrate em TH/s a partir do que a pool mandar.
 *
 * Aceita numero cru (na unidade `padraoHs`, em H/s) ou texto com unidade,
 * como "185.2 TH/s" — a AntPool usa os dois formatos conforme o endpoint.
 */
export function rateToTh(v: string | number | null | undefined, padraoHs: number): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? (v * padraoHs) / 1e12 : 0;
  const m = v.trim().match(/^([\d.,]+(?:e[+-]?\d+)?)\s*([KMGTPE]?)H\/?s?$/i);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? (n * UNIDADE[m[2].toUpperCase()]) / 1e12 : 0;
  }
  return (num(v) * padraoHs) / 1e12;
}
