import { NextResponse } from 'next/server';
import {
  chartOutages,
  deleteEnergyBill,
  downtimeByWorker,
  firstSnapshotSince,
  energyBills,
  fullOutages,
  type OutagePeriod,
  minedByMonth,
  minerOutageEvents,
  outageEvents,
  paidByMonth,
  persistedDowntime,
  persistedOutage,
  saveEnergyBill,
} from '@/lib/db';
import { fetchMarket } from '@/lib/market';
import { getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** De onde saiu o valor minerado do mes, em ordem de confiabilidade. */
export type MinedSource = 'diario' | 'pagamentos' | 'manual' | 'nenhum';

/** Custo de energia acumulado no mes em curso, rateado pelos dias decorridos. */
export interface CostEstimate {
  usd: number;
  brl: number;
  /** convertido pelo preco do BTC de agora */
  sats: number;
  elapsedDays: number;
  daysInMonth: number;
  /** o mes fechado, se o contrato nao mudar */
  fullMonthUsd: number;
  fullMonthSats: number;
}

export interface BillView {
  month: string;
  satsPaid: number;
  paidAt: number | null;
  note: string;
  minedSats: number;
  minedSource: MinedSource;
  /** dias com registro no historico diario da pool */
  daysWithData: number;
  /** pagamentos recebidos no mes, quando essa e a fonte */
  paymentsCount: number;
  minedManual: number | null;
  /** valor faturado pelo cobrador em dolar, quando informado */
  invoiceUsd: number | null;
  /** a fatura convertida pela cotacao de agora; flutua ate o pagamento */
  invoiceSats: number | null;
  /** de onde saiu o custo desta competencia, em ordem de firmeza */
  costSource: 'pago' | 'faturado' | 'estimado' | 'nenhum';
  /** custo DA COMPETENCIA: fatura bruta menos o credito gerado neste mes */
  costSats: number;
  /** CAIXA: o que saiu (ou vai sair) nesta data, ja liquido do que foi abatido */
  cashSats: number;
  /** abatimento recebido nesta fatura e de qual competencia veio */
  creditAppliedUsd: number | null;
  creditAppliedMonth: string | null;
  creditAppliedSats: number;
  /** o que MEDIMOS de parada nesta competencia — referencia, nao entra na conta */
  creditEarnedSats: number;
  /** o que o cobrador REALMENTE concedeu por esta competencia, visto nas faturas */
  creditGrantedUsd: number;
  creditGrantedSats: number;
  /** true quando alguma fatura ja abateu credito desta competencia */
  creditSettled: boolean;
  /** existe lancamento gravado para esta competencia — pode ser apagado */
  hasRecord: boolean;
  /** custo da energia em dolar: a fatura quando existe, senao o convertido */
  costUsd: number;
  /** consumo estimado do mes pelos watts configurados */
  kwhMonth: number;
  /** preco efetivo da energia — o que interessa para comparar com o mercado */
  usdPerKwh: number | null;
  brlPerKwh: number | null;
  netSats: number;
  burnPct: number | null;
  partial: boolean;
  /** custo estimado pelo contrato: rateado no mes em curso, cheio se encerrado */
  estimate: CostEstimate | null;
  /** indisponibilidade apurada nesta competencia */
  downtime: DowntimeReport | null;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(month: string): { start: number; end: number } {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(y, m - 1, 1).getTime(), end: new Date(y, m, 1).getTime() };
}

/**
 * Custo estimado da competencia pelo contrato configurado.
 * No mes corrente e o rateio pelos dias ja decorridos; num mes ja encerrado e
 * o contrato cheio. Serve enquanto a fatura nao for lancada — assim que ela
 * entra, o valor real toma o lugar.
 */
function estimateForMonth(
  month: string,
  contractedUsdMonth: number,
  btcUsd: number,
  usdBrl: number,
): CostEstimate | null {
  const { start, end } = monthBounds(month);
  const now = Date.now();
  // Mes ainda no futuro nao tem o que estimar.
  if (now < start || contractedUsdMonth <= 0) return null;

  const daysInMonth = (end - start) / 86_400_000;
  const elapsedDays = now >= end ? daysInMonth : (now - start) / 86_400_000;
  const usd = contractedUsdMonth * (elapsedDays / daysInMonth);

  return {
    usd,
    brl: usd * usdBrl,
    sats: btcUsd > 0 ? Math.round((usd / btcUsd) * 1e8) : 0,
    elapsedDays,
    daysInMonth,
    fullMonthUsd: contractedUsdMonth,
    fullMonthSats: btcUsd > 0 ? Math.round((contractedUsdMonth / btcUsd) * 1e8) : 0,
  };
}

async function payload() {
  const daily = minedByMonth();
  const paid = paidByMonth();
  const bills = energyBills();
  const market = await fetchMarket();
  const settings = getSettings();
  const now = currentMonth();

  const contractedUsdMonth = settings.miners
    .filter((x) => x.enabled)
    .filter((x) => (x.costMode === 'inherit' ? settings.costModel : x.costMode) === 'fixedUsd')
    .reduce((a, x) => a + (x.fixedMonthlyUsd ?? settings.fixedMonthlyUsdPerMiner), 0);

  const contractedByWorker = new Map(
    settings.miners
      .filter((x) => x.enabled)
      .filter((x) => (x.costMode === 'inherit' ? settings.costModel : x.costMode) === 'fixedUsd')
      .map((x) => [
        x.worker,
        { label: x.label || x.worker, monthlyUsd: x.fixedMonthlyUsd ?? settings.fixedMonthlyUsdPerMiner },
      ]),
  );

  // Quanto o cobrador concedeu por cada competencia, lido dos abatimentos que
  // ele aplicou nas faturas. E este numero, e nao o que medimos, que altera o
  // custo — a nossa medicao serve para conferir se o abatimento veio certo.
  const grantedByMonth = new Map<string, { usd: number; sats: number }>();
  for (const b of bills) {
    if (!b.credit_applied_usd || !b.credit_applied_month) continue;
    const taxa =
      b.sats > 0 && b.invoice_usd && b.invoice_usd > 0
        ? b.sats / b.invoice_usd
        : market.btcUsd > 0
          ? 1e8 / market.btcUsd
          : 0;
    const atual = grantedByMonth.get(b.credit_applied_month) ?? { usd: 0, sats: 0 };
    atual.usd += b.credit_applied_usd;
    atual.sats += Math.round(b.credit_applied_usd * taxa);
    grantedByMonth.set(b.credit_applied_month, atual);
  }

  // Potencia instalada, base do consumo estimado. Depende do watts configurado
  // em cada maquina — se ele estiver errado, o preco por kWh sai errado junto.
  const wattsInstalados = settings.miners.filter((m) => m.enabled).reduce((a, m) => a + m.watts, 0);

  const months = [...new Set([...bills.map((b) => b.month), ...daily.keys(), ...paid.keys()])]
    .sort()
    .reverse();

  const rows: BillView[] = months.map((month) => {
    const bill = bills.find((b) => b.month === month);
    const d = daily.get(month);
    const p = paid.get(month);

    // Precedencia: valor informado a mao > historico diario > pagamentos.
    let minedSats = 0;
    let minedSource: MinedSource = 'nenhum';
    if (bill?.mined_manual != null && bill.mined_manual > 0) {
      minedSats = bill.mined_manual;
      minedSource = 'manual';
    } else if (d && d.btc > 0) {
      minedSats = Math.round(d.btc * 1e8);
      minedSource = 'diario';
    } else if (p && p.btc > 0) {
      minedSats = Math.round(p.btc * 1e8);
      minedSource = 'pagamentos';
    }

    const satsPaid = bill?.sats ?? 0;
    const invoiceUsd = bill?.invoice_usd ?? null;
    // A fatura chega em dolar; ate o pagamento, o valor em sats acompanha o
    // preco do bitcoin. Depois de pago, o que vale e o sats efetivamente pago.
    const invoiceSats =
      invoiceUsd !== null && market.btcUsd > 0 ? Math.round((invoiceUsd / market.btcUsd) * 1e8) : null;
    const est = estimateForMonth(month, contractedUsdMonth, market.btcUsd, market.usdBrl);

    const costSource: 'pago' | 'faturado' | 'estimado' | 'nenhum' =
      satsPaid > 0 ? 'pago' : invoiceSats !== null ? 'faturado' : est ? 'estimado' : 'nenhum';

    // CAIXA: o valor que efetivamente sai neste mes, ja liquido do abatimento
    // que o cobrador aplicou — e exatamente o que a fatura pede.
    const cashSats = satsPaid > 0 ? satsPaid : (invoiceSats ?? est?.sats ?? 0);

    // O abatimento veio em dolar. Quando o mes ja foi pago, a taxa implicita do
    // proprio pagamento e a conversao mais fiel; senao usamos a cotacao de agora.
    const creditAppliedUsd = bill?.credit_applied_usd ?? null;
    const satsPorDolar =
      satsPaid > 0 && invoiceUsd && invoiceUsd > 0
        ? satsPaid / invoiceUsd
        : market.btcUsd > 0
          ? 1e8 / market.btcUsd
          : 0;
    const creditAppliedSats = creditAppliedUsd ? Math.round(creditAppliedUsd * satsPorDolar) : 0;

    // A nossa medicao de parada e apenas referencia para conferir a fatura.
    const dtMes = downtimeReport(month, contractedByWorker, market.btcUsd, market.usdBrl);
    const creditEarnedSats = dtMes?.combinedCreditSats ?? 0;

    // COMPETENCIA: devolve o abatimento que pertence a outro mes e desconta o
    // que o cobrador de fato concedeu por este — nunca o que nos medimos.
    const granted = grantedByMonth.get(month) ?? { usd: 0, sats: 0 };
    const costSats = Math.max(0, cashSats + creditAppliedSats - granted.sats);
    const creditSettled = granted.sats > 0;

    // Preco efetivo da energia. O consumo e estimado pela potencia instalada no
    // trecho ja decorrido da competencia; no mes corrente, custo e consumo
    // crescem juntos, entao a razao entre eles se mantem valida.
    const { start: mStart, end: mEnd } = monthBounds(month);
    const horasDecorridas = Math.max(0, (Math.min(Date.now(), mEnd) - mStart) / 3_600_000);
    const kwhMonth = (wattsInstalados / 1000) * horasDecorridas;
    const costUsd = invoiceUsd ?? (market.btcUsd > 0 ? (costSats / 1e8) * market.btcUsd : 0);
    const usdPerKwh = kwhMonth > 0 && costUsd > 0 ? costUsd / kwhMonth : null;

    return {
      month,
      satsPaid,
      paidAt: bill?.paid_at ?? null,
      note: bill?.note ?? '',
      minedSats,
      minedSource,
      daysWithData: d?.days ?? 0,
      paymentsCount: p?.count ?? 0,
      minedManual: bill?.mined_manual ?? null,
      invoiceUsd,
      invoiceSats,
      costSource,
      costSats,
      cashSats,
      creditAppliedUsd,
      creditAppliedMonth: bill?.credit_applied_month ?? null,
      creditAppliedSats,
      creditEarnedSats,
      creditGrantedUsd: granted.usd,
      creditGrantedSats: granted.sats,
      creditSettled,
      hasRecord: bill !== undefined,
      costUsd,
      kwhMonth,
      usdPerKwh,
      brlPerKwh: usdPerKwh !== null && market.usdBrl > 0 ? usdPerKwh * market.usdBrl : null,
      netSats: minedSats - satsPaid,
      burnPct: minedSats > 0 ? (satsPaid / minedSats) * 100 : null,
      partial: month === now,
      estimate: est,
      downtime: dtMes,
    };
  });

  return {
    bills: rows,
    market,
    // Mantido para o bloco em destaque do mes corrente.
    downtime: rows.find((r) => r.partial)?.downtime ?? null,
    contractedUsdMonth,
    contractedSatsAtCurrentPrice:
      market.btcUsd > 0 ? Math.round((contractedUsdMonth / market.btcUsd) * 1e8) : 0,
  };
}

export interface DowntimeMiner {
  worker: string;
  label: string;
  downHours: number;
  /** fatia da janela observada em que ficou parada, % */
  downPct: number;
  monthlyUsd: number;
  creditUsd: number;
  creditBrl: number;
  creditSats: number;
}

export interface DowntimeReport {
  /** inicio do mes de competencia — o periodo que o desconto deveria cobrir */
  since: number;
  /** primeira coleta que temos dentro do mes; antes disso nao ha observacao */
  observedFrom: number | null;
  until: number;
  coverageHours: number;
  hoursInMonth: number;
  /** fracao do mes que conseguimos observar, % */
  coveragePct: number;
  miners: DowntimeMiner[];
  /** soma das horas paradas de todas as maquinas (horas-maquina) */
  totalDownHours: number;
  /** maior parada individual, em horas de relogio */
  worstDownHours: number;
  /** media por maquina afetada, em horas de relogio */
  avgDownHours: number;
  /** quantas maquinas tiveram alguma parada */
  affected: number;
  totalCreditUsd: number;
  totalCreditBrl: number;
  totalCreditSats: number;
  /** tempo em que TODAS as maquinas estavam paradas ao mesmo tempo, medido aqui */
  fullOutageHours: number;
  /** cada queda total da fazenda medida pelo coletor, com inicio e fim */
  measuredPeriods: OutagePeriod[];
  /** paradas de maquina que nao sao explicadas pela queda geral */
  individualPeriods: { worker: string; label: string; from: number; to: number; ms: number; soloMs: number }[];
  /** quedas totais vistas no historico da pool antes do inicio da nossa coleta */
  importedOutageHours: number;
  importedPeriods: OutagePeriod[];
  /** ate onde o historico importado consegue enxergar */
  importedFrom: number | null;
  /** medido + importado, e o credito correspondente */
  combinedOutageHours: number;
  combinedCreditUsd: number;
  combinedCreditSats: number;
}

/**
 * Desconto proporcional ao tempo parado.
 *
 * Maquina parada nao consome energia, entao as horas de queda viram credito
 * sobre o contrato mensal. Vale so para parada de verdade: maquina degradada
 * continua puxando quase toda a potencia e nao gera desconto.
 */
function downtimeReport(
  month: string,
  contractedByWorker: Map<string, { label: string; monthlyUsd: number }>,
  btcUsd: number,
  usdBrl: number,
): DowntimeReport | null {
  const { start: startOfMonth, end: endOfMonth } = monthBounds(month);
  const hoursInMonth = (endOfMonth - startOfMonth) / 3_600_000;
  // Num mes encerrado a janela termina no fim do mes, nao agora.
  const until = Math.min(Date.now(), endOfMonth);
  if (until <= startOfMonth) return null;

  // O consolidado gravado sobrevive a poda dos snapshots; ficamos com o maior
  // entre o que ainda da para calcular e o que ja foi registrado.
  const vivo = downtimeByWorker(startOfMonth, until);
  const gravado = persistedDowntime(month);
  const workers = new Set([...vivo.map((r) => r.worker), ...gravado.keys()]);

  const rows = [...workers]
    .sort()
    .map((worker) => {
      const a = vivo.find((r) => r.worker === worker);
      const b = gravado.get(worker);
      return {
        worker,
        downMs: Math.max(a?.downMs ?? 0, b?.downMs ?? 0),
        coverageMs: Math.max(a?.coverageMs ?? 0, b?.coverageMs ?? 0),
        activeMs: 0,
      };
    });
  if (rows.length === 0) return null;
  // Cobertura = tempo efetivamente observado dentro do mes de competencia.
  const coverageHours = Math.max(...rows.map((r) => r.coverageMs)) / 3_600_000;

  const miners: DowntimeMiner[] = rows.map((r) => {
    const cfg = contractedByWorker.get(r.worker);
    const monthlyUsd = cfg?.monthlyUsd ?? 0;
    const downHours = r.downMs / 3_600_000;
    const creditUsd = (monthlyUsd / hoursInMonth) * downHours;
    return {
      worker: r.worker,
      label: cfg?.label ?? r.worker,
      downHours,
      downPct: r.coverageMs > 0 ? (r.downMs / r.coverageMs) * 100 : 0,
      monthlyUsd,
      creditUsd,
      creditBrl: creditUsd * usdBrl,
      creditSats: btcUsd > 0 ? Math.round((creditUsd / btcUsd) * 1e8) : 0,
    };
  });

  const totalCreditUsd = miners.reduce((a, m) => a + m.creditUsd, 0);
  const gravadoOutage = persistedOutage(month);
  const vivoOutage = fullOutages(startOfMonth, until);
  const outage = {
    downMs: Math.max(vivoOutage.downMs, gravadoOutage?.downMs ?? 0),
  };

  // Eventos gravados sobrevivem a poda; os do calculo vivo entram por cima.
  const eventos = new Map(outageEvents(month).map((p) => [p.from, p]));
  for (const p of vivoOutage.periods) {
    const anterior = eventos.get(p.from);
    eventos.set(p.from, anterior && anterior.to > p.to ? anterior : p);
  }
  const measuredPeriods = [...eventos.values()].sort((a, b) => a.from - b.from);

  // Quanto de cada parada de maquina NAO coincide com a queda geral. E esse
  // excedente que revela a maquina que ficou fora sozinha.
  const soloMs = (p: { from: number; to: number }) => {
    const coberto = measuredPeriods.reduce(
      (a, f) => a + Math.max(0, Math.min(p.to, f.to) - Math.max(p.from, f.from)),
      0,
    );
    return Math.max(0, p.to - p.from - coberto);
  };

  const individualPeriods = minerOutageEvents(month)
    .map((p) => ({
      worker: p.worker,
      label: contractedByWorker.get(p.worker)?.label ?? p.worker,
      from: p.from,
      to: p.to,
      ms: p.ms,
      soloMs: soloMs(p),
    }))
    // Alguns minutos de defasagem entre as deteccoes sao ruido, nao parada solo.
    .filter((p) => p.soloMs > 10 * 60_000)
    .sort((a, b) => b.soloMs - a.soloMs);
  const comParada = miners.filter((m) => m.downHours > 0.01);

  // Quedas do historico da pool, restritas ao trecho anterior ao inicio da
  // nossa coleta — o que veio depois ja esta medido e contaria duas vezes.
  const observedFrom = firstSnapshotSince(startOfMonth, until) ?? gravadoOutage?.observedFrom ?? null;
  const limite = observedFrom ?? until;
  const dezMin = chartOutages('min', startOfMonth, limite);
  const horaria = chartOutages('hour', startOfMonth, limite);
  // A serie de 10 minutos e mais precisa; a horaria so cobre o que ela nao alcanca.
  const importado =
    dezMin.covered && horaria.covered && horaria.covered.from < dezMin.covered.from
      ? {
          periods: [
            ...horaria.periods.filter((p) => p.to <= dezMin.covered!.from),
            ...dezMin.periods,
          ],
          from: horaria.covered.from,
        }
      : dezMin.covered
        ? { periods: dezMin.periods, from: dezMin.covered.from }
        : horaria.covered
          ? { periods: horaria.periods, from: horaria.covered.from }
          : { periods: [], from: null };

  const importedMs = importado.periods.reduce((a, p) => a + p.ms, 0);
  const importedHours = importedMs / 3_600_000;

  // Queda total derruba a fazenda inteira: o credito e o contrato cheio.
  const contratoTotalUsd = [...contractedByWorker.values()].reduce((a, x) => a + x.monthlyUsd, 0);
  const creditoHora = contratoTotalUsd / hoursInMonth;
  const combinedOutageHours = outage.downMs / 3_600_000 + importedHours;
  const combinedCreditUsd = totalCreditUsd + importedHours * creditoHora;

  return {
    since: startOfMonth,
    measuredPeriods,
    individualPeriods,
    importedOutageHours: importedHours,
    importedPeriods: importado.periods,
    importedFrom: importado.from,
    combinedOutageHours,
    combinedCreditUsd,
    combinedCreditSats: btcUsd > 0 ? Math.round((combinedCreditUsd / btcUsd) * 1e8) : 0,
    worstDownHours: comParada.length ? Math.max(...comParada.map((m) => m.downHours)) : 0,
    avgDownHours: comParada.length
      ? comParada.reduce((a, m) => a + m.downHours, 0) / comParada.length
      : 0,
    affected: comParada.length,
    observedFrom,
    until,
    coverageHours,
    hoursInMonth,
    coveragePct: (coverageHours / hoursInMonth) * 100,
    miners: miners.sort((a, b) => b.downHours - a.downHours),
    totalDownHours: miners.reduce((a, m) => a + m.downHours, 0),
    totalCreditUsd,
    totalCreditBrl: totalCreditUsd * usdBrl,
    totalCreditSats: btcUsd > 0 ? Math.round((totalCreditUsd / btcUsd) * 1e8) : 0,
    fullOutageHours: outage.downMs / 3_600_000,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await payload(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Erro' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      month?: string;
      sats?: number;
      paidAt?: number | null;
      note?: string;
      minedManual?: number | null;
      invoiceUsd?: number | null;
      creditAppliedUsd?: number | null;
      creditAppliedMonth?: string | null;
      /** move o lancamento de um mes para outro */
      renameFrom?: string;
    };

    if (!body.month || !MONTH_RE.test(body.month)) {
      return NextResponse.json({ error: 'Mes invalido — use o formato AAAA-MM' }, { status: 400 });
    }
    const sats = Number(body.sats);
    if (!Number.isFinite(sats) || sats < 0) {
      return NextResponse.json({ error: 'Valor em satoshis invalido' }, { status: 400 });
    }
    const minedManual =
      body.minedManual === null || body.minedManual === undefined || Number(body.minedManual) <= 0
        ? null
        : Number(body.minedManual);

    const invoiceUsd =
      body.invoiceUsd === null || body.invoiceUsd === undefined || Number(body.invoiceUsd) <= 0
        ? null
        : Number(body.invoiceUsd);

    // Faturar e pagar sao eventos distintos: basta um dos dois para registrar.
    if (sats === 0 && invoiceUsd === null) {
      return NextResponse.json(
        { error: 'Informe a fatura em dolar ou o valor pago em satoshis' },
        { status: 400 },
      );
    }

    const creditAppliedUsd =
      body.creditAppliedUsd === null ||
      body.creditAppliedUsd === undefined ||
      Number(body.creditAppliedUsd) <= 0
        ? null
        : Number(body.creditAppliedUsd);
    const creditAppliedMonth =
      creditAppliedUsd !== null && body.creditAppliedMonth && MONTH_RE.test(body.creditAppliedMonth)
        ? body.creditAppliedMonth
        : null;

    saveEnergyBill({
      month: body.month,
      sats,
      paidAt: body.paidAt ?? null,
      note: (body.note ?? '').slice(0, 200),
      minedManual,
      invoiceUsd,
      creditAppliedUsd,
      creditAppliedMonth,
    });

    if (body.renameFrom && MONTH_RE.test(body.renameFrom) && body.renameFrom !== body.month) {
      deleteEnergyBill(body.renameFrom);
    }

    return NextResponse.json(await payload());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Erro' }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const month = new URL(req.url).searchParams.get('month');
  if (!month || !MONTH_RE.test(month)) {
    return NextResponse.json({ error: 'Mes invalido' }, { status: 400 });
  }
  deleteEnergyBill(month);
  return NextResponse.json(await payload());
}
