import { dailyWorkerWeights, payments, profitDays } from './db';
import { effectiveCostMode, effectiveTariff, inCourtesy } from './settings';
import type { MinerConfig, Settings } from './types';

/**
 * Retorno do investimento por maquina.
 *
 * Tres fontes, em ordem de fidelidade, porque nenhuma sozinha cobre a
 * operacao inteira:
 *
 * 1. Onde ha snapshot local, a receita do dia e rateada pelo hashrate que
 *    cada maquina entregou naquele dia. E o rateio fiel.
 * 2. Antes disso, a receita diaria da pool ainda existe, mas nao ha hashrate
 *    por maquina em lugar nenhum — a ViaBTC nao guarda. Divide-se entre as
 *    maquinas que ja estavam ligadas no dia.
 * 3. Antes do alcance da receita diaria (~30 dias na pool), so restam os
 *    pagamentos. Cada um e espalhado pelos dias que ele remunera.
 *
 * A distincao importa para quem le: `preciseDays` e `estimatedDays` dizem
 * quanto do numero e medicao e quanto e rateio por cabeca.
 *
 * A moeda de cada lado e a moeda em que o valor de fato existe. A receita se
 * acumula em satoshis, que e o que entrou e continua na carteira de quem faz
 * holding: converter cada dia pela cotacao daquele dia registraria um lucro
 * que nunca foi realizado em real. O custo se acumula em dolar, que e como o
 * contrato de energia esta escrito. Os dois so viram real no fim, pela
 * cotacao de agora — e por isso o payback sobe e desce com o preco do BTC,
 * como a posicao de fato faz.
 */
export interface PaybackView {
  purchaseBrl: number;
  returnedBrl: number;
  /** o que a maquina minerou, liquido de nada — e o que esta na carteira */
  returnedSats: number;
  /** energia acumulada em dolar, a moeda do contrato */
  energyUsd: number;
  pct: number;
  measuredDays: number;
  from: string | null;
  preciseDays: number;
  estimatedDays: number;
  profitDayBrl: number;
  daysLeft: number | null;
  etaAt: number | null;
  done: boolean;
}

const DIA = 86_400_000;
const dia = (t: number): string => new Date(t).toLocaleDateString('sv-SE');

/**
 * Custo de energia de um dia, na moeda em que o contrato existe.
 * Valor fechado e dolar; tarifa medida e real. Misturar os dois numa moeda so
 * antes da hora obrigaria a inventar um cambio para o passado.
 */
function custoDia(
  settings: Settings,
  m: MinerConfig,
  at: number,
): { usd: number; brl: number } {
  if (effectiveCostMode(settings, m) === 'fixedUsd') {
    if (inCourtesy(m, at)) return { usd: 0, brl: 0 };
    return { usd: (m.fixedMonthlyUsd ?? settings.fixedMonthlyUsdPerMiner) / 30, brl: 0 };
  }
  return { usd: 0, brl: (m.watts / 1000) * 24 * effectiveTariff(settings, m) };
}

/** Quando esta maquina passou a produzir, na melhor informacao disponivel. */
function entrouEm(settings: Settings, m: MinerConfig): number | null {
  return m.startedAt ?? m.firstHashAt ?? settings.miningStartedAt;
}

/**
 * Receita de cada dia, em BTC.
 *
 * Onde a pool ainda publica o diario, usa o diario. Antes disso, cada
 * pagamento e espalhado pelos dias desde o pagamento anterior — nao e o dia
 * exato de producao, mas e o unico rastro que sobra e nao inventa valor:
 * a soma bate com o que caiu na carteira.
 */
function receitaPorDia(desde: number): Map<string, number> {
  const out = new Map<string, number>();
  const diarios = profitDays(120);
  for (const d of diarios) if (d.total > 0) out.set(d.date, d.total);

  const primeiroDiario = diarios.length ? diarios.map((d) => d.date).sort()[0] : null;
  const pagos = payments(200)
    .filter((p) => p.amount > 0)
    .sort((a, b) => a.create_time - b.create_time);

  let anterior = desde;
  for (const p of pagos) {
    const fim = p.create_time;
    // O pagamento remunera producao anterior a ele: o dia dele fica de fora.
    const dias: string[] = [];
    for (let t = anterior; t < fim; t += DIA) {
      const d = dia(t);
      if (primeiroDiario && d >= primeiroDiario) continue; // ja coberto pelo diario
      if (t >= desde) dias.push(d);
    }
    if (dias.length > 0) {
      const parte = p.amount / dias.length;
      for (const d of dias) out.set(d, (out.get(d) ?? 0) + parte);
    }
    anterior = fim;
  }
  return out;
}

export interface AcumuladoWorker {
  sats: number;
  custoUsd: number;
  custoBrl: number;
}

export interface RetornoMedido {
  porWorker: Map<string, AcumuladoWorker>;
  dias: number;
  desde: string | null;
  precisos: number;
  estimados: number;
}

/**
 * Soma, dia a dia, o que cada maquina rendeu menos o que custou.
 * O dia corrente fica de fora: a receita esta incompleta e o custo nao, o que
 * faria toda maquina parecer pior do que e.
 */
export function retornoMedido(settings: Settings): RetornoMedido {
  const inicio = settings.miningStartedAt ?? Date.now() - 60 * DIA;
  const pesos = dailyWorkerWeights(120);
  const receitas = receitaPorDia(inicio);
  const hoje = dia(Date.now());

  const ativas = settings.miners.filter((m) => m.enabled);
  const porWorker = new Map<string, AcumuladoWorker>();
  const usados: string[] = [];
  let precisos = 0;
  let estimados = 0;

  for (const d of [...receitas.keys()].sort()) {
    if (d >= hoje) continue;
    const receitaBtc = receitas.get(d) ?? 0;
    if (receitaBtc <= 0) continue;

    const meioDia = new Date(`${d}T12:00:00`).getTime();
    const doDia = pesos.get(d);
    const totalPeso = doDia ? [...doDia.values()].reduce((a, b) => a + b, 0) : 0;

    // Maquinas que ja estavam ligadas nesse dia. Sem data de entrada, a
    // maquina conta desde o inicio da operacao — e o que o dono declarou.
    const presentes = ativas.filter((m) => {
      const inicioM = entrouEm(settings, m);
      return inicioM === null || inicioM <= meioDia + DIA;
    });
    if (presentes.length === 0) continue;

    usados.push(d);
    if (doDia && totalPeso > 0) precisos += 1;
    else estimados += 1;

    for (const m of presentes) {
      const fracao =
        doDia && totalPeso > 0 ? (doDia.get(m.worker) ?? 0) / totalPeso : 1 / presentes.length;
      const custo = custoDia(settings, m, meioDia);
      const acc = porWorker.get(m.worker) ?? { sats: 0, custoUsd: 0, custoBrl: 0 };
      acc.sats += receitaBtc * fracao * 1e8;
      acc.custoUsd += custo.usd;
      acc.custoBrl += custo.brl;
      porWorker.set(m.worker, acc);
    }
  }

  return { porWorker, dias: usados.length, desde: usados[0] ?? null, precisos, estimados };
}

/** Monta a visao de payback de uma maquina a partir do retorno ja medido. */
export function paybackDe(
  cfg: MinerConfig,
  medido: RetornoMedido,
  profitDayBrl: number,
  market: { btcBrl: number; usdBrl: number },
): PaybackView | null {
  if (cfg.purchaseBrl <= 0) return null;

  const acc = medido.porWorker.get(cfg.worker) ?? { sats: 0, custoUsd: 0, custoBrl: 0 };
  // Tudo vira real aqui, na cotacao de agora: os satoshis porque continuam na
  // carteira, o dolar porque a conta de energia e cotada nele.
  const returnedBrl = (acc.sats / 1e8) * market.btcBrl - acc.custoUsd * market.usdBrl - acc.custoBrl;
  const falta = cfg.purchaseBrl - returnedBrl;
  const done = falta <= 0;
  // Sem lucro nao ha prazo: projetar com numero negativo daria uma data no
  // passado, que e pior que admitir que nao da para prever.
  const daysLeft = done ? 0 : profitDayBrl > 0 ? falta / profitDayBrl : null;

  return {
    purchaseBrl: cfg.purchaseBrl,
    returnedBrl,
    returnedSats: Math.round(acc.sats),
    energyUsd: acc.custoUsd,
    pct: (returnedBrl / cfg.purchaseBrl) * 100,
    measuredDays: medido.dias,
    from: medido.desde,
    preciseDays: medido.precisos,
    estimatedDays: medido.estimados,
    profitDayBrl,
    daysLeft,
    etaAt: daysLeft === null ? null : Date.now() + daysLeft * DIA,
    done,
  };
}
