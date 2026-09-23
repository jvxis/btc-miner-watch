import {
  avgHashrateByWorker,
  degradedSinceMap,
  fleetAverage,
  fleetSeries,
  profitDays,
  recentHashrates,
  recentSparklines,
  recentEvents,
} from './db';
import { dailyCostResolver } from './energy';
import { isOffline as offline } from './health';
import { fmtClock, fmtDuration } from './format';
import { blockSubsidy, fetchMarket } from './market';
import { pollStatus } from './poller';
import { paybackDe, retornoMedido } from './payback';
import { minerConfig, minerCost, syncMiners } from './settings';
import type { Alert, FleetTotals, MinerView, OverviewPayload, Settings } from './types';
import { num, toTh, viabtc } from './viabtc';

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

/**
 * Receita por TH/s por dia.
 * Preferimos o numero real: media dos ultimos dias pagos pela pool dividida
 * pelo hashrate da fazenda. Sem historico, caimos no valor teorico da rede.
 */
function revenuePerThDay(
  fleetTh: number,
  days: { date: string; total: number }[],
  difficulty: number | null,
  height: number | null,
): { btcPerThDay: number; source: 'pool' | 'rede' } {
  // Ignora o dia corrente, que ainda esta incompleto.
  const usable = days.slice(1, 8).filter((d) => d.total > 0);
  if (usable.length >= 2 && fleetTh > 0) {
    const avgBtc = usable.reduce((s, d) => s + d.total, 0) / usable.length;
    return { btcPerThDay: avgBtc / fleetTh, source: 'pool' };
  }
  if (difficulty && difficulty > 0) {
    const subsidy = blockSubsidy(height);
    // 1 TH/s rende, por dia: 86400 * subsidy * 1e12 / (dificuldade * 2^32)
    const btcPerThDay = (86_400 * subsidy * 1e12) / (difficulty * 2 ** 32);
    return { btcPerThDay, source: 'rede' };
  }
  return { btcPerThDay: 0, source: 'rede' };
}

export async function buildOverview(): Promise<OverviewPayload> {
  const [workers, account, market, summary] = await Promise.all([
    viabtc.workers(),
    viabtc.accountHashrate(),
    fetchMarket(),
    viabtc.profitSummary().catch(() => null),
  ]);

  const accountInfo = await viabtc.account().catch(() => null);

  const settings: Settings = syncMiners(
    workers.map((w) => ({ worker: w.worker_name, hashing: toTh(w.hashrate_10min) > 0 })),
  );
  const now = Date.now();

  const avg24 = avgHashrateByWorker(24);
  const sparks = recentSparklines(6, 15);
  const days = profitDays(90);
  /** Janela curta que decide status e alerta — reage em minutos, nao em 1 hora. */
  const recentes = recentHashrates(15);
  const degradadaDesde = degradedSinceMap();
  // Rateio da receita ja paga pela pool, dia a dia, para o payback por maquina.
  const retorno = retornoMedido(settings);

  const fleet1h = workers.reduce((s, w) => s + toTh(w.hashrate_1hour), 0);
  const fleet10m = workers.reduce((s, w) => s + toTh(w.hashrate_10min), 0);
  const { btcPerThDay } = revenuePerThDay(fleet1h, days, market.difficulty, market.blockHeight);

  const medianH = median(workers.map((w) => toTh(w.hashrate_1hour)).filter((h) => h > 0));
  const fixedDailyPerMiner =
    workers.length > 0 ? settings.fixedMonthlyCostBrl / 30 / workers.length : 0;

  const miners: MinerView[] = workers.map((w) => {
    const cfg = minerConfig(settings, w.worker_name);
    const h10m = toTh(w.hashrate_10min);
    const h1h = toTh(w.hashrate_1hour);
    const lastActive = w.last_active * 1000;
    const secondsSinceShare = Math.max(0, Math.round((now - lastActive) / 1000));

    const local = avg24.get(w.worker_name);
    const hashrate24hLocal = local && local.samples >= 3 ? local.avg : null;
    const uptime24h = local && local.samples >= 3 ? (local.online / local.samples) * 100 : null;

    const performance = cfg.nominalTh > 0 ? h1h / cfg.nominalTh : 0;
    const rejectPct = num(w.reject_rate);

    // A referencia de status e a mediana das leituras de 10min dos ultimos
    // minutos. Sem historico local suficiente, cai na leitura instantanea.
    const amostras = recentes.get(w.worker_name) ?? [];
    const hashrateRef = amostras.length >= 3 ? median(amostras) : h10m;
    const performanceRef = cfg.nominalTh > 0 ? hashrateRef / cfg.nominalTh : 0;

    const isOffline = offline(settings, { lastActive, h10m }, now);
    const abaixoRef = performanceRef * 100 < settings.alertHashratePct;
    const abaixo1h = performance * 100 < settings.alertHashratePct;
    // Ja produzindo bem, mas a media de 1h ainda carrega a queda recente:
    // e recuperacao, nao defeito, e nao deve gerar alerta.
    const isRecovering = !isOffline && !abaixoRef && abaixo1h;
    const isDegraded = !isOffline && (abaixoRef || rejectPct > settings.alertRejectPct);

    const energy = minerCost(settings, cfg, market.usdBrl);
    const kwhDay = energy.kwhDay;
    const costDayBrl = energy.dayBrl + fixedDailyPerMiner;
    const costDayUsd = market.usdBrl > 0 ? costDayBrl / market.usdBrl : energy.dayUsd;

    const revenueDayBtc = btcPerThDay * h1h;
    const revenueDayBrl = revenueDayBtc * market.btcBrl;
    const revenueDayUsd = revenueDayBtc * market.btcUsd;

    const profitDayBrl = revenueDayBrl - costDayBrl;
    const profitDayUsd = revenueDayUsd - costDayUsd;

    const health = clamp(
      Math.min(performanceRef, 1.05) * 100 * 0.5 +
        (uptime24h ?? (isOffline ? 0 : 100)) * 0.3 +
        clamp(100 - rejectPct * 25) * 0.2,
    );

    return {
      workerId: w.worker_id,
      worker: w.worker_name,
      label: cfg.label || w.worker_name,
      location: cfg.location,
      status: isOffline ? 'offline' : isDegraded ? 'degraded' : isRecovering ? 'recovering' : 'online',
      hashrate10m: h10m,
      hashrate1h: h1h,
      hashrate24hLocal,
      nominalTh: cfg.nominalTh,
      performance,
      performanceRef,
      hashrateRef,
      rejectPct,
      lastActive,
      secondsSinceShare,
      watts: cfg.watts,
      kwhDay,
      efficiency: h1h > 0 ? cfg.watts / h1h : 0,
      costDayBrl,
      costDayUsd,
      costMode: energy.mode,
      revenueDayBtc,
      revenueDayBrl,
      revenueDayUsd,
      profitDayBrl,
      profitDayUsd,
      marginPct: revenueDayBrl > 0 ? (profitDayBrl / revenueDayBrl) * 100 : 0,
      breakevenBtcBrl: revenueDayBtc > 0 ? costDayBrl / revenueDayBtc : 0,
      uptime24h,
      health,
      degradedSince: degradadaDesde.get(w.worker_name) ?? null,
      payback: paybackDe(cfg, retorno, profitDayBrl, market),
      vsFleetPct: medianH > 0 ? ((h1h - medianH) / medianH) * 100 : 0,
      sparkline: sparks.get(w.worker_name) ?? [],
      onlineTime7d: w.online_time_7d ?? null,
      onlineTime30d: w.online_time_30d ?? null,
    };
  });

  // ------------------------------------------------------------ totais
  const active = miners.filter((m) => m.status !== 'offline');
  const nominalTh = miners.reduce((s, m) => s + m.nominalTh, 0);
  const powerKw = active.reduce((s, m) => s + m.watts, 0) / 1000;
  const kwhDay = powerKw * 24;
  // A eficiencia medida usa a referencia curta: a media de 1h leva ate uma
  // hora para se limpar depois de uma queda e inflaria o J/TH sem motivo.
  const fleetRef = miners.reduce((s, m) => s + m.hashrateRef, 0);

  // Contrato fechado e cobrado mesmo com a maquina parada; tarifa por kWh, nao.
  const costDayBrl = miners.reduce(
    (s, m) => s + (m.costMode === 'fixedUsd' || m.status !== 'offline' ? m.costDayBrl : 0),
    0,
  );
  // Parcela que varia com a tarifa: so as maquinas cobradas por kWh e ligadas.
  const tariffed = miners.filter((m) => m.costMode === 'tariff' && m.status !== 'offline');
  const kwhDayTariffed = tariffed.reduce((s, m) => s + m.kwhDay, 0);
  const variableBrl = tariffed.reduce(
    (s, m) => s + minerCost(settings, minerConfig(settings, m.worker), market.usdBrl).dayBrl,
    0,
  );
  const costDayFixedBrl = costDayBrl - variableBrl;
  const revenueDayBtc = miners.reduce((s, m) => s + m.revenueDayBtc, 0);
  const revenueDayBrl = revenueDayBtc * market.btcBrl;
  const revenueDayUsd = revenueDayBtc * market.btcUsd;
  const costDayUsd = market.usdBrl > 0 ? costDayBrl / market.usdBrl : 0;
  const profitDayBrl = revenueDayBrl - costDayBrl;

  const local24 = miners.map((m) => m.hashrate24hLocal).filter((v): v is number => v !== null);
  const uptimes = miners.map((m) => m.uptime24h).filter((v): v is number => v !== null);
  const balanceBtc = num(accountInfo?.balance.find((b) => b.coin === viabtc.coin)?.amount ?? 0);

  const fleetHs = fleet1h * 1e12;

  const totals: FleetTotals = {
    hashrate10m: fleet10m,
    hashrate1h: fleet1h,
    hashrateRef: fleetRef,
    hashrate24hLocal: local24.length === miners.length && local24.length > 0 ? local24.reduce((a, b) => a + b, 0) : null,
    hashrate7d: fleetAverage(24 * 7),
    hashrate30d: fleetAverage(24 * 30),
    nominalTh,
    performance: nominalTh > 0 ? fleet1h / nominalTh : 0,
    activeWorkers: account.active_workers,
    inactiveWorkers: account.unactive_workers,
    totalWorkers: miners.length,
    rejectPct: miners.length ? miners.reduce((s, m) => s + m.rejectPct, 0) / miners.length : 0,
    powerKw,
    kwhDay,
    costDayBrl,
    costDayUsd,
    costDayFixedBrl,
    kwhDayTariffed,
    revenueDayBtc,
    revenueDayBrl,
    revenueDayUsd,
    profitDayBrl,
    profitDayUsd: revenueDayUsd - costDayUsd,
    marginPct: revenueDayBrl > 0 ? (profitDayBrl / revenueDayBrl) * 100 : 0,
    efficiency: fleetRef > 0 ? (powerKw * 1000) / fleetRef : 0,
    efficiencyNominal:
      nominalTh > 0 ? miners.reduce((s, m) => s + m.watts, 0) / nominalTh : 0,
    // O custo esta ancorado em dolar; dividir pelo preco do BTC da o custo em
    // satoshis, que encolhe quando o bitcoin sobe.
    revenueDaySats: revenueDayBtc * 1e8,
    costDaySats: market.btcUsd > 0 ? (costDayUsd / market.btcUsd) * 1e8 : 0,
    profitDaySats: revenueDayBtc * 1e8 - (market.btcUsd > 0 ? (costDayUsd / market.btcUsd) * 1e8 : 0),
    burnPct:
      revenueDayBtc > 0 && market.btcUsd > 0
        ? (costDayUsd / market.btcUsd / revenueDayBtc) * 100
        : 0,
    satsPerThDay: btcPerThDay * 1e8,
    hashpriceUsd: btcPerThDay * 1000 * market.btcUsd,
    breakevenBtcUsd: revenueDayBtc > 0 ? costDayUsd / revenueDayBtc : 0,
    breakevenBtcBrl: revenueDayBtc > 0 ? costDayBrl / revenueDayBtc : 0,
    costPerBtcBrl: revenueDayBtc > 0 ? costDayBrl / revenueDayBtc : 0,
    balanceBtc,
    balanceBrl: balanceBtc * market.btcBrl,
    balanceUsd: balanceBtc * market.btcUsd,
    totalProfitBtc: num(summary?.total_profit ?? 0),
    networkSharePpm: market.networkHashrate ? (fleetHs / market.networkHashrate) * 1e6 : null,
    uptime24h: uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null,
  };

  // ------------------------------------------------------------ alertas
  const alerts: Alert[] = [];
  const status = pollStatus();

  if (!status.ok && status.consecutiveErrors > 0) {
    alerts.push({
      id: 'pool',
      level: 'critical',
      worker: null,
      title: 'Falha ao consultar a ViaBTC',
      detail: status.message,
      since: status.lastAttempt,
    });
  }
  if (market.stale) {
    alerts.push({
      id: 'market',
      level: 'warning',
      worker: null,
      title: 'Cotacao desatualizada',
      detail: 'Nao foi possivel atualizar o preco do BTC; valores em fiat podem estar defasados.',
      since: market.updatedAt,
    });
  }

  for (const m of miners) {
    if (m.status === 'offline') {
      alerts.push({
        id: `off:${m.worker}`,
        level: 'critical',
        worker: m.worker,
        title: `${m.label} offline`,
        detail: `Sem shares ha ${Math.round(m.secondsSinceShare / 60)} min — perda estimada de ${(m.revenueDayBrl > 0 ? m.revenueDayBrl : (revenueDayBrl / Math.max(1, miners.length))).toFixed(2)} BRL/dia`,
        since: m.lastActive,
      });
      continue;
    }
    // So alerta o que esta realmente abaixo agora — maquina em recuperacao
    // aparece no painel com o proprio estado, sem poluir os alertas.
    if (m.status === 'degraded' && m.performanceRef * 100 < settings.alertHashratePct) {
      // Queda passageira e ruido; a que persiste e a que pede visita. Um
      // alerta so, que muda de texto ao cruzar o limite, evita duplicar a
      // mesma maquina na lista.
      const ha = m.degradedSince !== null ? now - m.degradedSince : 0;
      const prolongada = ha >= settings.alertDegradedMinutes * 60_000;
      const numeros = `${m.hashrateRef.toFixed(1)} TH/s = ${(m.performanceRef * 100).toFixed(0)}% do nominal (${m.nominalTh} TH/s)`;
      // A duracao entra desde o primeiro minuto: saber se a queda tem 3 ou 40
      // minutos muda a decisao, mesmo antes de virar aviso prolongado.
      const desde =
        m.degradedSince !== null
          ? ` · ha ${fmtDuration(ha / 1000)}, desde ${fmtClock(m.degradedSince)}`
          : '';

      alerts.push({
        id: prolongada ? `sust:${m.worker}` : `low:${m.worker}`,
        level: 'warning',
        worker: m.worker,
        title: prolongada
          ? `${m.label} degradada ha ${fmtDuration(ha / 1000)}`
          : `${m.label} abaixo do esperado`,
        detail: `${numeros}${desde}`,
        since: m.degradedSince ?? now,
      });
    }
    if (m.rejectPct > settings.alertRejectPct) {
      alerts.push({
        id: `rej:${m.worker}`,
        level: 'warning',
        worker: m.worker,
        title: `${m.label} com rejeicao alta`,
        detail: `Reject rate de ${m.rejectPct.toFixed(2)}% (limite ${settings.alertRejectPct}%)`,
        since: now,
      });
    }
  }

  if (totals.profitDayBrl < 0) {
    alerts.push({
      id: 'negative',
      level: 'critical',
      worker: null,
      title: 'Operacao no prejuizo',
      detail: `Custo de energia acima da receita em ${Math.abs(totals.profitDayBrl).toFixed(2)} BRL/dia`,
      since: now,
    });
  }

  // Dentro do mesmo nivel, a degradacao prolongada vem antes da passageira.
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const peso = (a: Alert) => order[a.level] * 10 + (a.id.startsWith('sust:') ? 0 : 1);
  alerts.sort((a, b) => peso(a) - peso(b));

  // ------------------------------------------------------------ series
  const localChart = fleetSeries(24, 10);
  const chart = localChart.length >= 6
    ? localChart.map((p) => ({ t: p.t, h: p.h, reject: p.reject }))
    : (await viabtc.chart('min', 144).catch(() => [])).map((p) => ({
        t: p.timestamp * 1000,
        h: toTh(p.hashrate),
        reject: num(p.reject_rate),
      }));

  // Meses ja faturados usam a conta real; o resto segue o contrato configurado.
  const janela = days.slice(0, 45).reverse();
  const custoDoDia = dailyCostResolver(janela, costDayBrl, market.btcBrl);
  const revenueHistory = janela.map((d) => {
    const c = custoDoDia(d.date);
    return {
      date: d.date,
      btc: d.total,
      brl: d.total * market.btcBrl,
      usd: d.total * market.btcUsd,
      costBrl: c.costBrl,
      profitBrl: d.total * market.btcBrl - c.costBrl,
      costReal: c.real,
    };
  });

  return {
    totals,
    miners: miners.sort((a, b) => a.worker.localeCompare(b.worker)),
    alerts,
    market,
    chart,
    revenueHistory,
    settings,
    poolStatus: { ok: status.ok, message: status.message, lastSuccess: status.lastSuccess },
    generatedAt: now,
  };
}

export function eventLog(limit = 60) {
  return recentEvents(limit);
}
