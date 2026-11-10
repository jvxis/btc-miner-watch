import { blocosNovos, poolBlocks, registrarBlocos } from './db';
import type { PoolBlock, PoolBlockStats } from './types';

/**
 * Blocos encontrados pela pool.
 *
 * A API da ViaBTC nao publica bloco nenhum — todos os endpoints candidatos
 * respondem 404. Quem sabe e a rede: o mempool.space identifica a pool de
 * cada bloco pela assinatura do coinbase e mantem um indice por pool. Vale
 * para qualquer pool, entao a AntPool usa o mesmo caminho.
 *
 * O peso disso na receita depende do modo de pagamento (ver pools/modo.ts):
 * em PPS+ quase nada, em PPLNS e de onde vem o pagamento. Em qualquer modo, a
 * cadencia da pool e o unico jeito de saber se ela continua competitiva.
 */

const BASE = 'https://mempool.space/api/v1/mining/pool';

async function json<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface BlocoBruto {
  height: number;
  timestamp: number;
  tx_count: number;
  extras?: { reward?: number; totalFees?: number };
}

interface StatsBruto {
  blockCount?: { all?: number; '24h'?: number; '1w'?: number };
  blockShare?: { all?: number; '24h'?: number; '1w'?: number };
  estimatedHashrate?: number;
}

/**
 * Busca os blocos recentes da pool e grava os que ainda nao conheciamos.
 * Devolve os novos, ja em ordem de altura, para quem quiser avisar.
 *
 * `primeiraVez` marca tudo como avisado sem notificar: na primeira execucao a
 * API devolve os ultimos cem blocos, e avisar sobre bloco de uma semana atras
 * seria so barulho.
 */
export async function sincronizarBlocos(pool: string, primeiraVez: boolean): Promise<PoolBlock[]> {
  const brutos = await json<BlocoBruto[]>(`${BASE}/${pool}/blocks`);
  if (!brutos || brutos.length === 0) return [];

  const blocos: PoolBlock[] = brutos.map((b) => ({
    height: b.height,
    ts: b.timestamp * 1000,
    rewardSats: Math.round(b.extras?.reward ?? 0),
    feesSats: Math.round(b.extras?.totalFees ?? 0),
    txCount: b.tx_count,
  }));

  registrarBlocos(pool, blocos, primeiraVez);
  return primeiraVez ? [] : blocosNovos(pool);
}

/** Estatisticas da pool na rede, para o card. Sem bloquear se a fonte cair. */
export async function estatisticasDaPool(pool: string): Promise<PoolBlockStats | null> {
  const s = await json<StatsBruto>(`${BASE}/${pool}`);
  if (!s) return null;
  return {
    blocks24h: s.blockCount?.['24h'] ?? null,
    blocks7d: s.blockCount?.['1w'] ?? null,
    blocksAll: s.blockCount?.all ?? null,
    share24hPct: s.blockShare?.['24h'] != null ? s.blockShare['24h']! * 100 : null,
    share7dPct: s.blockShare?.['1w'] != null ? s.blockShare['1w']! * 100 : null,
    hashrate: s.estimatedHashrate ?? null,
    updatedAt: Date.now(),
  };
}

/** Os ultimos blocos gravados, para a tela. */
export function blocosRecentes(pool: string, limite = 12): PoolBlock[] {
  return poolBlocks(pool, limite);
}
