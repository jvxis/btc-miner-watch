import { profitDaysDaPool } from '../db';
import type { Settings } from '../types';
import { antpool } from './antpool';
import { detectarModo, type ModoPagamento } from './modo';
import { viabtc } from './viabtc';
import {
  POOL_LABEL,
  type PoolChartPoint,
  type PoolHashrate,
  type PoolId,
  type PoolProvider,
  type PoolWorker,
} from './types';

export { num, toTh } from './util';
export { POOL_LABEL, PoolError } from './types';
export type { PoolAccount, PoolId, PoolProvider, PoolWorker } from './types';
export type { ModoPagamento } from './modo';

export const POOLS: Record<PoolId, PoolProvider> = { viabtc, antpool };
const ORDEM: PoolId[] = ['viabtc', 'antpool'];

/** Pools com chave no ambiente — as que da para consultar. */
export function poolsConfiguradas(): PoolProvider[] {
  return ORDEM.map((id) => POOLS[id]).filter((p) => p.configured());
}

/** Pools que o painel le agora, conforme a configuracao. */
export function poolsAtivas(settings: Settings): PoolProvider[] {
  if (settings.pool !== 'ambas') return [POOLS[settings.pool]];
  const prontas = poolsConfiguradas();
  // Sem chave nenhuma, deixa a ViaBTC falhar com a mensagem de chave ausente.
  return prontas.length > 0 ? prontas : [viabtc];
}

/**
 * A pool "da casa": dona do card de blocos e destino na migracao.
 * Em 'ambas' vale a AntPool, tratada como o destino da migracao.
 */
export function poolPrincipal(settings: Settings): PoolProvider {
  return settings.pool === 'ambas' ? antpool : POOLS[settings.pool];
}

export function rotuloFonte(settings: Settings): string {
  return poolsAtivas(settings)
    .map((p) => p.label)
    .join(' + ');
}

/** Modo de pagamento de uma pool, pelos dias ja gravados. */
export function modoDaPool(id: PoolId): ModoPagamento | null {
  return detectarModo(id, profitDaysDaPool(id));
}

/** Modo de cada pool ativa que ja pagou algum dia. */
export function modosAtivos(settings: Settings): ModoPagamento[] {
  return poolsAtivas(settings).flatMap((p) => modoDaPool(p.id) ?? []);
}

export function poolsDisponiveis(): { id: PoolId; label: string; configurada: boolean }[] {
  return ORDEM.map((id) => ({ id, label: POOL_LABEL[id], configurada: POOLS[id].configured() }));
}

// ------------------------------------------------------------ leitura combinada

/**
 * Junta a mesma maquina vista em mais de uma pool.
 *
 * Na migracao, a ViaBTC continua listando a maquina que saiu, parada e com o
 * ultimo share antigo; a AntPool lista a mesma, produzindo. A maquina e uma
 * so: o hashrate soma (no minuto da troca ela entrega um pouco em cada), o
 * ultimo share e o mais recente e a pool dela e onde esse share caiu.
 */
function juntar(listas: PoolWorker[][]): PoolWorker[] {
  const porNome = new Map<string, PoolWorker[]>();
  for (const w of listas.flat()) {
    const arr = porNome.get(w.name) ?? [];
    arr.push(w);
    porNome.set(w.name, arr);
  }
  return [...porNome.values()].map((vs) => {
    if (vs.length === 1) return vs[0];
    const atual = vs.reduce((a, b) => (b.lastActive > a.lastActive ? b : a));
    const maisForte = vs.reduce((a, b) => (b.h10m > a.h10m ? b : a));
    return {
      ...atual,
      h10m: vs.reduce((s, w) => s + w.h10m, 0),
      h1h: vs.reduce((s, w) => s + w.h1h, 0),
      h24h: vs.reduce((s, w) => s + w.h24h, 0),
      rejectPct: maisForte.rejectPct,
      status: vs.some((w) => w.status === 'active') ? 'active' : atual.status,
      online7d: vs.find((w) => w.online7d)?.online7d ?? null,
      online30d: vs.find((w) => w.online30d)?.online30d ?? null,
    };
  });
}

export interface LeituraMaquinas {
  workers: PoolWorker[];
  account: PoolHashrate;
  /** pools que falharam neste ciclo, com o motivo */
  falhas: { pool: PoolId; erro: string }[];
}

/**
 * Le maquinas e hashrate da conta de todas as pools ativas.
 *
 * Com uma pool so, a falha dela e a falha do ciclo, como sempre foi. Com as
 * duas, uma fora do ar nao derruba a leitura da outra.
 */
export async function lerMaquinas(settings: Settings): Promise<LeituraMaquinas> {
  const pools = poolsAtivas(settings);
  const ignorados = new Set(settings.ignoredWorkers ?? []);
  const res = await Promise.allSettled(
    pools.map(async (p) => {
      const [workers, account] = await Promise.all([p.workers(), p.accountHashrate()]);
      // A contagem da pool inclui os ignorados; tira-los dela tambem.
      const fora = workers.filter((w) => ignorados.has(w.name));
      const ativosFora = fora.filter((w) => w.h10m > 0).length;
      return {
        pool: p.id,
        workers: workers.filter((w) => !ignorados.has(w.name)),
        account: {
          ...account,
          active: Math.max(0, account.active - ativosFora),
          inactive: Math.max(0, account.inactive - (fora.length - ativosFora)),
        },
      };
    }),
  );

  const ok = res.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const falhas = res.flatMap((r, i) =>
    r.status === 'rejected'
      ? [{ pool: pools[i].id, erro: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
      : [],
  );
  if (ok.length === 0) {
    const primeira = res.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw primeira?.reason ?? new Error('Nenhuma pool configurada');
  }

  if (ok.length === 1 && pools.length === 1) {
    return { workers: ok[0].workers, account: ok[0].account, falhas };
  }

  let workers = juntar(ok.map((o) => o.workers));
  if (falhas.length > 0) {
    // Com uma pool fora, a maquina parada na que respondeu pode estar
    // produzindo na outra — a ViaBTC segue listando, parada, quem ja migrou.
    // Neste ciclo so entra quem prova que esta vivo; o resto fica sem leitura,
    // que e diferente de parado e nao gera alerta nem credito.
    const agora = Date.now();
    workers = workers.filter((w) => w.h10m > 0 || agora - w.lastActive < 15 * 60_000);
  }
  // Contar pelas maquinas ja juntadas: somar o "ativas" de cada pool contaria
  // duas vezes a maquina que produziu nas duas durante a troca.
  const ativas = workers.filter((w) => w.h10m > 0).length;
  return {
    workers,
    account: {
      h10m: ok.reduce((s, o) => s + o.account.h10m, 0),
      h1h: ok.reduce((s, o) => s + o.account.h1h, 0),
      h24h: ok.reduce((s, o) => s + o.account.h24h, 0),
      active: ativas,
      inactive: workers.length - ativas,
    },
    falhas,
  };
}

/**
 * Serie de hashrate da conta somando as pools ativas.
 *
 * So entra o instante que todas informam: a falta de ponto de uma pool
 * pareceria queda da fazenda, e a serie existe justamente para achar queda.
 */
export async function lerGrafico(
  settings: Settings,
  interval: 'min' | 'hour',
  hours: number,
): Promise<PoolChartPoint[]> {
  const pools = poolsAtivas(settings);
  const series = await Promise.all(pools.map((p) => p.chart(interval, hours).catch(() => null)));
  if (series.some((s) => s === null || s.length === 0)) {
    // Uma pool sem serie: melhor nao importar nada do que importar meia fazenda.
    return series.length === 1 ? (series[0] ?? []) : [];
  }
  const validas = series as PoolChartPoint[][];
  if (validas.length === 1) return validas[0];

  const soma = new Map<number, { p: PoolChartPoint; n: number }>();
  for (const s of validas) {
    for (const p of s) {
      const a = soma.get(p.ts);
      soma.set(
        p.ts,
        a
          ? { p: { ts: p.ts, th: a.p.th + p.th, rejectPct: Math.max(a.p.rejectPct, p.rejectPct) }, n: a.n + 1 }
          : { p: { ...p }, n: 1 },
      );
    }
  }
  return [...soma.values()]
    .filter((x) => x.n === validas.length)
    .map((x) => x.p)
    .sort((a, b) => a.ts - b.ts);
}
