// Criterio de degradacao, compartilhado entre o coletor e o motor de metricas.
// Os dois precisam concordar: se o coletor marcasse por um criterio e a tela
// mostrasse outro, o alerta de "degradada ha 2h" apareceria em maquina verde.

import type { MinerConfig, Settings } from './types';

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Hashrate de referencia: a mediana das leituras recentes de 10 minutos.
 * A leitura instantanea da pool oscila cerca de 30% entre coletas, entao a
 * mediana evita que o status trema; sem amostras suficientes, cai na leitura.
 */
export function hashrateRef(amostras: number[], fallback: number): number {
  return amostras.length >= 3 ? median(amostras) : fallback;
}

export function isDegraded(
  settings: Settings,
  cfg: MinerConfig,
  ref: number,
  rejectPct: number,
): boolean {
  const perf = cfg.nominalTh > 0 ? (ref / cfg.nominalTh) * 100 : 0;
  return perf < settings.alertHashratePct || rejectPct > settings.alertRejectPct;
}
