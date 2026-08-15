import {
  kvGet,
  kvSet,
  degradedSinceMap,
  logEvent,
  markDegraded,
  persistMonthlyDowntime,
  recentHashrates,
  pruneOldData,
  upsertChart,
  upsertPayments,
  upsertProfitDays,
  writeFleetSnapshot,
  writeSnapshots,
  type SnapshotRow,
} from './db';
import { fetchMarket } from './market';
import { hashrateRef, isDegraded } from './health';
import { despacharAvisos, type Aviso } from './notify';
import { getSettings, minerConfig, syncMiners } from './settings';
import { num, toTh, viabtc } from './viabtc';

export interface PollStatus {
  ok: boolean;
  message: string;
  lastSuccess: number | null;
  lastAttempt: number;
  consecutiveErrors: number;
}

const STATUS_KEY = 'poll_status';
const globalRef = globalThis as unknown as { __minerWatchPoller?: NodeJS.Timeout; __minerWatchTick?: number };

export function pollStatus(): PollStatus {
  return (
    kvGet<PollStatus>(STATUS_KEY)?.value ?? {
      ok: false,
      message: 'Coletor ainda nao executou',
      lastSuccess: null,
      lastAttempt: 0,
      consecutiveErrors: 0,
    }
  );
}

/** Estado anterior por maquina, usado para registrar transicoes no log de eventos. */
const lastStatus = new Map<string, string>();

export async function pollOnce(): Promise<PollStatus> {
  const prev = pollStatus();
  const ts = Date.now();

  try {
    const [workers, account] = await Promise.all([viabtc.workers(), viabtc.accountHashrate()]);

    const rows: SnapshotRow[] = workers.map((w) => ({
      worker: w.worker_name,
      workerId: w.worker_id,
      h10m: toTh(w.hashrate_10min),
      h1h: toTh(w.hashrate_1hour),
      reject: num(w.reject_rate),
      status: w.worker_status,
      lastActive: w.last_active * 1000,
    }));

    writeSnapshots(ts, rows);
    syncMiners(rows.map((r) => ({ worker: r.worker, hashing: r.h10m > 0 })));

    const settings = getSettings();
    const offlineMs = settings.alertOfflineMinutes * 60_000;

    // Marca desde quando cada maquina esta degradada, pelo mesmo criterio que
    // a tela usa. Maquina parada nao conta como degradada: e outro problema.
    const recentes = recentHashrates(15);
    const avisos: Aviso[] = [];
    const degradadaDesde = degradedSinceMap();

    for (const r of rows) {
      const cfg = minerConfig(settings, r.worker);
      const nome = cfg.label || r.worker;
      const parada = r.status !== 'active' || ts - r.lastActive > offlineMs || r.h10m <= 0;
      const ref = hashrateRef(recentes.get(r.worker) ?? [], r.h10m);
      const degradada = !parada && isDegraded(settings, cfg, ref, r.reject);
      markDegraded(r.worker, degradada, ts);

      if (parada) {
        avisos.push({
          id: `off:${r.worker}`,
          texto: `🔴 ${nome} OFFLINE\nSem shares ha ${Math.round((ts - r.lastActive) / 60000)} min.`,
          textoFim: `🟢 ${nome} voltou a produzir.`,
        });
        continue;
      }

      // So o que persiste vira aviso: queda de poucos minutos e ruido.
      const desde = degradadaDesde.get(r.worker);
      if (degradada && desde && ts - desde >= settings.alertDegradedMinutes * 60_000) {
        const pct = cfg.nominalTh > 0 ? (ref / cfg.nominalTh) * 100 : 0;
        avisos.push({
          id: `sust:${r.worker}`,
          texto:
            `🟡 ${nome} degradada ha ${Math.round((ts - desde) / 60000)} min\n` +
            `${ref.toFixed(1)} TH/s = ${pct.toFixed(0)}% do nominal (${cfg.nominalTh} TH/s)\n` +
            `Rejeicao ${r.reject.toFixed(2)}%.`,
          textoFim: `🟢 ${nome} normalizou.`,
        });
      }
    }

    if (rows.length > 0 && rows.every((r) => r.status !== 'active' || ts - r.lastActive > offlineMs || r.h10m <= 0)) {
      avisos.push({
        id: 'fazenda-parada',
        texto: `🔴 FAZENDA PARADA\nAs ${rows.length} maquinas estao sem produzir.`,
        textoFim: '🟢 Fazenda voltou a produzir.',
      });
    }
    for (const r of rows) {
      const isOffline = r.status !== 'active' || ts - r.lastActive > offlineMs;
      const state = isOffline ? 'offline' : 'online';
      const before = lastStatus.get(r.worker);
      if (before && before !== state) {
        logEvent(
          state === 'offline' ? 'critical' : 'info',
          state === 'offline' ? 'miner_offline' : 'miner_online',
          r.worker,
          state === 'offline'
            ? `Sem shares ha ${Math.round((ts - r.lastActive) / 60000)} min`
            : `Maquina voltou a produzir (${r.h10m.toFixed(1)} TH/s)`,
        );
      }
      lastStatus.set(r.worker, state);
    }

    const market = await fetchMarket();
    const rejectAvg = rows.length ? rows.reduce((s, r) => s + r.reject, 0) / rows.length : 0;

    writeFleetSnapshot(ts, {
      h10m: toTh(account.hashrate_10min),
      h1h: toTh(account.hashrate_1hour),
      active: account.active_workers,
      inactive: account.unactive_workers,
      reject: rejectAvg,
      btcUsd: market.btcUsd,
      btcBrl: market.btcBrl,
    });

    // Dados diarios e pagamentos mudam devagar: a cada 10 ciclos.
    const tick = (globalRef.__minerWatchTick ?? 0) + 1;
    globalRef.__minerWatchTick = tick;

    // Consolida a indisponibilidade do mes corrente para que o historico
    // sobreviva a poda dos snapshots.
    const agora = new Date();
    const mes = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();
    const fimMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 1).getTime();
    try {
      persistMonthlyDowntime(mes, inicioMes, Math.min(ts + 1, fimMes));
    } catch (e) {
      console.error('[miner-watch] falha ao consolidar indisponibilidade:', (e as Error).message);
    }

    // A serie de 10 minutos da pool cobre 24h e a horaria cobre 3 dias.
    // Importar sempre garante que quedas ocorridas com o app parado — ou
    // anteriores a instalacao — apareçam no relatorio de indisponibilidade.
    if (tick === 1 || tick % 5 === 0) {
      const [min10, hourly] = await Promise.all([
        viabtc.chart('min', 144).catch(() => []),
        viabtc.chart('hour', 72).catch(() => []),
      ]);
      if (min10.length) {
        upsertChart(
          'min',
          min10.map((p) => ({ ts: p.timestamp * 1000, hashrate: toTh(p.hashrate), reject: num(p.reject_rate) })),
        );
      }
      if (hourly.length) {
        upsertChart(
          'hour',
          hourly.map((p) => ({ ts: p.timestamp * 1000, hashrate: toTh(p.hashrate), reject: num(p.reject_rate) })),
        );
      }
    }

    if (tick === 1 || tick % 10 === 0) {
      const [profits, pays] = await Promise.all([
        viabtc.profitHistory(90).catch(() => []),
        viabtc.paymentHistory(90).catch(() => []),
      ]);
      if (profits.length) {
        upsertProfitDays(
          profits.map((p) => ({
            date: p.date,
            total: num(p.total_profit),
            pps: num(p.pps_profit),
            pplns: num(p.pplns_profit),
            solo: num(p.solo_profit),
          })),
        );
      }
      if (pays.length) {
        upsertPayments(
          pays.map((p) => ({
            id: p.id,
            amount: num(p.amount),
            address: p.address,
            tx: p.tx,
            create_time: p.create_time * 1000,
          })),
        );
      }
    }
    if (tick % 1440 === 0) pruneOldData();

    await despacharAvisos(settings, avisos);

    const status: PollStatus = {
      ok: true,
      message: `${rows.length} maquinas lidas`,
      lastSuccess: ts,
      lastAttempt: ts,
      consecutiveErrors: 0,
    };
    kvSet(STATUS_KEY, status);
    if (prev.consecutiveErrors > 0) logEvent('info', 'pool_recovered', null, 'Conexao com a ViaBTC restabelecida');
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: PollStatus = {
      ok: false,
      message,
      lastSuccess: prev.lastSuccess,
      lastAttempt: ts,
      consecutiveErrors: prev.consecutiveErrors + 1,
    };
    kvSet(STATUS_KEY, status);
    if (prev.consecutiveErrors === 0) logEvent('critical', 'pool_error', null, message);

    // Tres falhas seguidas: passa de instabilidade momentanea a problema real.
    if (status.consecutiveErrors >= 3) {
      try {
        await despacharAvisos(getSettings(), [
          {
            id: 'pool-inacessivel',
            texto: `🔴 SEM CONTATO COM A VIABTC\n${message}\n${status.consecutiveErrors} tentativas seguidas.`,
            textoFim: '🟢 Conexao com a ViaBTC restabelecida.',
          },
        ]);
      } catch {
        /* nao deixa a notificacao derrubar o coletor */
      }
    }
    return status;
  }
}

export function startPoller(): void {
  if (globalRef.__minerWatchPoller) return;
  const seconds = Math.max(30, Number(process.env.POLL_INTERVAL_SECONDS) || 60);
  void pollOnce();
  const timer = setInterval(() => void pollOnce(), seconds * 1000);
  timer.unref?.();
  globalRef.__minerWatchPoller = timer;
  console.log(`[miner-watch] coletor iniciado, intervalo de ${seconds}s`);
}
