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

/**
 * A maquina parou de produzir?
 *
 * O campo `worker_status` da pool NAO entra: a ViaBTC vira o worker para
 * 'unactive' assim que passam ~10 minutos sem share, que e mais apertado que
 * qualquer limite util e acontece em intervalo normal entre shares. Em
 * producao, boa parte da fazenda ja foi marcada 'unactive' num ciclo e voltou
 * no seguinte, com o hashrate de 10 minutos inalterado e o da conta sem se
 * mexer — nenhuma maquina tinha parado. Confiar nesse campo transforma um
 * detalhe do contador da pool numa enxurrada de alertas criticos.
 *
 * Sobra o que da para defender: tempo desde o ultimo share, no limite que o
 * dono configurou, ou hashrate zerado.
 */
export function isOffline(
  settings: Settings,
  row: { lastActive: number; h10m: number },
  now: number,
): boolean {
  return now - row.lastActive > settings.alertOfflineMinutes * 60_000 || row.h10m <= 0;
}

/**
 * Abaixo de quanto hashrate a maquina, e a fazenda, estao de fato paradas.
 *
 * E a segunda evidencia de parada: o intervalo sem share diz quando, isto diz
 * se. A margem e larga de proposito: maquina parada vai a zero, e mesmo uma
 * maquina bem degradada costuma ficar acima de um terco do nominal, entao 25%
 * nao confunde uma com a outra. Para a fazenda, metade do nominal somado —
 * uma queda geral real leva a conta a quase zero em minutos.
 */
export function pisosDeParada(settings: Settings): { maquinaTh: number; fazendaTh: number } {
  const ativas = settings.miners.filter((m) => m.enabled && m.nominalTh > 0);
  if (ativas.length === 0) return { maquinaTh: 0, fazendaTh: 0 };
  return {
    maquinaTh: 0.25 * Math.min(...ativas.map((m) => m.nominalTh)),
    fazendaTh: 0.5 * ativas.reduce((a, m) => a + m.nominalTh, 0),
  };
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
