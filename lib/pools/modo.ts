import type { PoolId } from './types';

/**
 * Modo de pagamento da conta, deduzido do que a pool pagou.
 *
 * A API da ViaBTC nao tem campo que diga o modo escolhido: nem a conta, nem o
 * resumo de lucro, e nenhum outro caminho respondeu. Mas o historico separa
 * cada dia em PPS, PPLNS e Solo, e isso e melhor que uma configuracao: mostra
 * o que foi pago de fato, e acompanha sozinho quando o modo troca. O preco e a
 * demora: a troca so aparece quando a pool fecha o primeiro dia no modo novo.
 *
 * Este arquivo nao fala com banco nem com rede, para a tela poder usar tambem.
 */

export type Modo = 'pps' | 'pplns' | 'solo' | 'misto';

export interface ModoPagamento {
  pool: PoolId;
  modo: Modo;
  /** como a pool chama: PPS+, FPPS, PPLNS... */
  rotulo: string;
  /** a receita do dia oscila com os blocos que a pool acha? */
  dependeDeBloco: boolean;
  /** ultimo dia pago lido */
  dia: string;
  /** primeiro dia seguido neste modo */
  desde: string;
  /** quantos dias fechados entram na media de receita */
  janelaDias: number;
  /** fatia de cada coluna no ultimo dia, em % */
  fatias: { pps: number; pplns: number; solo: number };
}

interface DiaPago {
  date: string;
  pps: number;
  pplns: number;
  solo: number;
}

/**
 * Com receita por share, 7 dias bastam. Dependendo de bloco, a media de 7 dias
 * ainda oscila uns 10% so por sorte da pool; com 14, uns 7%.
 */
export const JANELA_POR_SHARE = 7;
export const JANELA_POR_BLOCO = 14;

/** Fatia que um modo precisa ter para o dia ser dele; abaixo disso, ha troca no meio. */
const FATIA_DOMINANTE = 0.8;

function classificar(d: DiaPago): Modo | null {
  const total = d.pps + d.pplns + d.solo;
  if (total <= 0) return null;
  if (d.pps / total >= FATIA_DOMINANTE) return 'pps';
  if (d.pplns / total >= FATIA_DOMINANTE) return 'pplns';
  if (d.solo / total >= FATIA_DOMINANTE) return 'solo';
  return 'misto';
}

function rotuloDe(pool: PoolId, modo: Modo, d: DiaPago): string {
  if (modo === 'pplns') return 'PPLNS';
  if (modo === 'solo') return 'Solo';
  if (modo === 'misto') return 'Em transicao';
  if (pool === 'antpool') return 'FPPS';
  // No PPS+ da ViaBTC, as taxas dos blocos caem na coluna PPLNS.
  return d.pplns > 0 ? 'PPS+' : 'PPS';
}

/** `dias` do mais recente para o mais antigo. Sem dia pago, nao ha o que afirmar. */
export function detectarModo(pool: PoolId, dias: DiaPago[]): ModoPagamento | null {
  const pagos = dias.filter((d) => classificar(d) !== null);
  if (pagos.length === 0) return null;

  const ultimo = pagos[0];
  const modo = classificar(ultimo) as Modo;
  let desde = ultimo.date;
  for (const d of pagos.slice(1)) {
    if (classificar(d) !== modo) break;
    desde = d.date;
  }

  const total = ultimo.pps + ultimo.pplns + ultimo.solo;
  const dependeDeBloco = modo !== 'pps';
  return {
    pool,
    modo,
    rotulo: rotuloDe(pool, modo, ultimo),
    dependeDeBloco,
    dia: ultimo.date,
    desde,
    janelaDias: dependeDeBloco ? JANELA_POR_BLOCO : JANELA_POR_SHARE,
    fatias: {
      pps: (ultimo.pps / total) * 100,
      pplns: (ultimo.pplns / total) * 100,
      solo: (ultimo.solo / total) * 100,
    },
  };
}

/** Basta uma pool depender de bloco para a soma das duas oscilar. */
export function janelaDeReceita(modos: ModoPagamento[]): number {
  return modos.reduce((n, m) => Math.max(n, m.janelaDias), JANELA_POR_SHARE);
}

/** Dias que a pool ja fechou, do mais recente para o mais antigo. */
export function diasFechados<T extends { date: string; total: number }>(
  dias: T[],
  quantos: number,
  hoje: string,
): T[] {
  return dias.filter((d) => d.date < hoje && d.total > 0).slice(0, quantos);
}

/** Rodape do aviso de bloco no Telegram. */
export function avisoDeBloco(m: ModoPagamento | null): string {
  if (m?.modo === 'pps') return `Recompensa da pool, nao sua: em ${m.rotulo} o pagamento vem por share entregue.`;
  if (m?.modo === 'solo') return 'Bloco da pool, nao da sua conta: em Solo voce so recebe o bloco que voce mesmo achar.';
  if (m?.modo === 'pplns') return 'Recompensa dividida pelos shares recentes: em PPLNS e daqui que vem o seu pagamento.';
  return 'Recompensa da pool, dividida conforme o modo de pagamento da conta.';
}

/** Explicacao do card de blocos: muda com o que o bloco significa para a conta. */
export function notaDeBloco(m: ModoPagamento | null): string {
  if (m?.modo === 'pplns') {
    return (
      'Em PPLNS o pagamento vem destes blocos: cada um e dividido pelos shares recentes. Dia com poucos blocos paga ' +
      'menos e dia com muitos paga mais, sem que a fazenda tenha mudado. Antes de suspeitar de queda, olhe o hashrate.'
    );
  }
  if (m?.modo === 'pps') {
    return `A recompensa e da pool, nao sua. Em ${m.rotulo} o pagamento vem por share entregue, aconteca ou nao o bloco.`;
  }
  if (m?.modo === 'solo') {
    return 'Em Solo so paga o bloco que a sua propria conta achar; estes sao os da pool, e servem de comparacao.';
  }
  return 'O modo de pagamento esta em troca: o pagamento pode vir por share entregue ou pelos blocos encontrados.';
}
