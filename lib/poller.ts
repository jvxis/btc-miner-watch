import {
  kvGet,
  kvSet,
  acumularFazendaBaixa,
  avgHashrateByWorker,
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
import { hashrateRef, isDegraded, isOffline, pisosDeParada } from './health';
import { avisosAbertos, despacharAvisos, type Aviso } from './notify';
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
const FLEET_KEY = 'fleet_degraded_since';
const FLEET_UP_KEY = 'fleet_above_since';
const FLEET_LAST_KEY = 'fleet_low_last_ts';
const FLEET_LOW_FROM_KEY = 'fleet_low_from';
/**
 * Teto do intervalo somado por ciclo. O coletor roda a cada minuto; se o
 * app passou a noite fora, esse tempo nao foi observado e nao pode entrar
 * como se tivesse sido.
 */
const FLEET_STEP_MAX_MS = 5 * 60_000;
/**
 * Quanto a fazenda precisa passar acima do limite para o relogio zerar.
 *
 * Sem isso o alerta nunca sai numa fazenda real. Medindo em producao, o
 * conjunto oscila em torno do limite: cruza para cima varias vezes por turno
 * e o maior trecho continuo abaixo fica na casa da meia hora, ainda que o
 * tempo somado abaixo passe de um terco do dia. Exigir uma hora ininterrupta
 * era exigir uma falha que nao acontece.
 */
const FLEET_GRACE_MS = 15 * 60_000;
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

/** Competencia (ano-mes) de um instante. */
function mesCorrente(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Estado anterior por maquina, usado para registrar transicoes no log de eventos. */
const lastStatus = new Map<string, string>();

/**
 * Ciclos seguidos em que a maquina apareceu parada.
 *
 * Uma leitura isolada nao vira alerta critico. A pool ja mostrou que publica
 * estado inconsistente por um ciclo — e mesmo o nosso proprio criterio pode
 * tropecar numa coleta ruim. Acordar alguem as duas da manha exige que o
 * problema sobreviva ao ciclo seguinte.
 */
const ciclosParada = new Map<string, number>();

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

    // Marca desde quando cada maquina esta degradada, pelo mesmo criterio que
    // a tela usa. Maquina parada nao conta como degradada: e outro problema.
    const recentes = recentHashrates(15);
    const avisos: Aviso[] = [];
    const sustentadas: Aviso[] = [];
    const degradadaDesde = degradedSinceMap();
    let nominalTotal = 0;
    let medidoTotal = 0;
    const deficit: { worker: string; fracao: number }[] = [];

    for (const r of rows) {
      const cfg = minerConfig(settings, r.worker);
      const nome = cfg.label || r.worker;
      const parada = isOffline(settings, r, ts);
      ciclosParada.set(r.worker, parada ? (ciclosParada.get(r.worker) ?? 0) + 1 : 0);
      const paradaFirme = (ciclosParada.get(r.worker) ?? 0) >= 2;
      const ref = hashrateRef(recentes.get(r.worker) ?? [], r.h10m);
      const degradada = !parada && isDegraded(settings, cfg, ref, r.reject);
      markDegraded(r.worker, degradada, ts);

      if (cfg.enabled) {
        nominalTotal += cfg.nominalTh;
        medidoTotal += parada ? 0 : ref;
        // Maquina parada e assunto do credito de indisponibilidade, que ja
        // cobre as horas dela. Aqui entra so quem estava ligada entregando
        // menos, para as duas contas nunca cobrarem a mesma perda.
        if (!parada && cfg.nominalTh > 0) {
          deficit.push({ worker: r.worker, fracao: Math.max(0, 1 - ref / cfg.nominalTh) });
        }
      }

      if (parada) {
        // Parada de um ciclo so nao avisa, mas tambem nao vira degradacao:
        // enquanto nao se confirma, a maquina fica fora das duas contas.
        if (!paradaFirme) continue;
        avisos.push({
          id: `off:${r.worker}`,
          texto: `🔴 ${nome} OFFLINE\nSem shares ha ${Math.round((ts - r.lastActive) / 60000)} min.`,
          textoFim: `🟢 ${nome} voltou a produzir.`,
        });
        continue;
      }

      // So o que persiste e candidato a aviso: queda de poucos minutos e ruido.
      const desde = degradadaDesde.get(r.worker);
      if (degradada && desde && ts - desde >= settings.alertDegradedMinutes * 60_000) {
        const pct = cfg.nominalTh > 0 ? (ref / cfg.nominalTh) * 100 : 0;
        sustentadas.push({
          id: `sust:${r.worker}`,
          texto:
            `🟡 ${nome} degradada ha ${Math.round((ts - desde) / 60000)} min\n` +
            `${ref.toFixed(1)} TH/s = ${pct.toFixed(0)}% do nominal (${cfg.nominalTh} TH/s)\n` +
            `Rejeicao ${r.reject.toFixed(2)}%.`,
          textoFim: `🟢 ${nome} normalizou.`,
        });
      }
    }

    // Uma unidade oscilando e rotina de fazenda e nao justifica interromper
    // ninguem. O que justifica e o conjunto produzindo abaixo do nominal —
    // entao a degradacao individual so vira mensagem quando a fazenda inteira
    // tambem esta abaixo do limite dela ha o mesmo tempo. O limite do
    // conjunto e mais alto que o de uma unidade: a fazenda so chega la se
    // varias cairem juntas, ou se uma cair muito.
    const fazendaPct = nominalTotal > 0 ? (medidoTotal / nominalTotal) * 100 : 100;
    const fazendaAbaixo = fazendaPct < settings.alertFleetPct;
    const fazendaDesde = kvGet<number | null>(FLEET_KEY)?.value ?? null;
    const acimaDesde = kvGet<number | null>(FLEET_UP_KEY)?.value ?? null;

    if (fazendaAbaixo) {
      if (fazendaDesde === null) kvSet(FLEET_KEY, ts);
      // Recaiu antes de cumprir a carencia: a recuperacao nao valeu.
      if (acimaDesde !== null) kvSet(FLEET_UP_KEY, null);
    } else if (fazendaDesde !== null) {
      if (acimaDesde === null) {
        kvSet(FLEET_UP_KEY, ts);
      } else if (ts - acimaDesde >= FLEET_GRACE_MS) {
        kvSet(FLEET_KEY, null);
        kvSet(FLEET_UP_KEY, null);
      }
    }

    // Guarda o tempo abaixo da faixa e a producao perdida, para virar
    // sugestao de abatimento na cobranca do mes seguinte.
    //
    // Fazenda inteira parada nao conta aqui: aquelas horas ja viram credito
    // de indisponibilidade, e uma queda total deixa o conjunto em 0% do
    // nominal — apareceria como o pior episodio de desempenho do mes, com o
    // host sendo cobrado duas vezes pela mesma janela. Por isso o episodio
    // tem relogio proprio, que so corre quando ha maquina ligada.
    const semProducao = deficit.length === 0;
    const contaBaixa = fazendaAbaixo && !semProducao;
    const baixaDesde = kvGet<number | null>(FLEET_LOW_FROM_KEY)?.value ?? null;
    if (contaBaixa && baixaDesde === null) kvSet(FLEET_LOW_FROM_KEY, ts);
    if (!contaBaixa && baixaDesde !== null) kvSet(FLEET_LOW_FROM_KEY, null);

    const ultimaMedida = kvGet<number>(FLEET_LAST_KEY)?.value ?? null;
    kvSet(FLEET_LAST_KEY, ts);
    if (contaBaixa && ultimaMedida !== null) {
      const passo = Math.min(ts - ultimaMedida, FLEET_STEP_MAX_MS);
      if (passo > 0) {
        try {
          acumularFazendaBaixa(
            mesCorrente(ts),
            baixaDesde ?? ts,
            ts,
            passo,
            fazendaPct,
            deficit.map((x) => ({ worker: x.worker, lostMs: x.fracao * passo })),
          );
        } catch (e) {
          console.error('[miner-watch] falha ao acumular fazenda abaixo da faixa:', (e as Error).message);
        }
      }
    }

    const fazendaMin = fazendaDesde !== null ? Math.round((ts - fazendaDesde) / 60000) : 0;
    // So avisa enquanto esta de fato abaixo: completar a hora durante um
    // repique acima do limite daria uma mensagem desmentida pelo painel.
    const fazendaSustentada =
      fazendaAbaixo && fazendaDesde !== null && ts - fazendaDesde >= settings.alertDegradedMinutes * 60_000;

    // Uma vez avisada, a condicao segue aberta ate a propria maquina
    // normalizar. Fecha-la porque a fazenda melhorou mandaria um "voltou ao
    // normal" com a maquina ainda ruim.
    if (sustentadas.length > 0) {
      const jaAvisadas = avisosAbertos();
      for (const a of sustentadas) {
        if (fazendaSustentada) {
          avisos.push({
            ...a,
            texto: `${a.texto}\nFazenda em ${fazendaPct.toFixed(0)}% do nominal ha ${fazendaMin} min.`,
          });
        } else if (jaAvisadas.has(a.id)) {
          avisos.push(a);
        }
      }
    }

    // --------------------------------------------- terceiro nivel: cronico
    //
    // Os dois primeiros avisos reagem a mudanca: algo caiu, algo degradou.
    // Nenhum dispara quando a fazenda simplesmente vive abaixo do contratado
    // ha dias sem piorar — que e justamente o caso que mais custa dinheiro,
    // porque ninguem e acordado por ele.
    //
    // O criterio e a media da janela, nao um cronometro: oscilar em torno do
    // limite nao zera nada, e o numero que dispara o aviso e o mesmo que a
    // mensagem mostra, entao da para conferir sem abrir o painel.
    const janelaH = Math.max(1, settings.alertChronicHours);
    const medias = avgHashrateByWorker(janelaH);
    const amostras = [...medias.values()].map((x) => x.samples);
    const amostrasMax = amostras.length > 0 ? Math.max(...amostras) : 0;
    // Sem a janela quase inteira coletada a media puxaria para baixo sozinha.
    const janelaCompleta = amostrasMax >= janelaH * 60 * 0.8;

    if (janelaCompleta) {
      const linhas = rows
        .map((r) => {
          const cfg = minerConfig(settings, r.worker);
          const media = medias.get(r.worker)?.avg ?? 0;
          const desde = degradadaDesde.get(r.worker) ?? null;
          return {
            nome: cfg.label || r.worker,
            nominal: cfg.enabled ? cfg.nominalTh : 0,
            media,
            deficit: Math.max(0, (cfg.enabled ? cfg.nominalTh : 0) - media),
            horas: desde !== null ? (ts - desde) / 3_600_000 : null,
          };
        })
        .filter((x) => x.nominal > 0);

      const nominalJanela = linhas.reduce((a, x) => a + x.nominal, 0);
      const mediaJanela = linhas.reduce((a, x) => a + x.media, 0);
      const pctJanela = nominalJanela > 0 ? (mediaJanela / nominalJanela) * 100 : 100;
      const cronicas = linhas.filter((x) => x.horas !== null && x.horas >= janelaH);

      if (pctJanela < settings.alertFleetPct && cronicas.length > 0) {
        const faltando = Math.max(0, nominalJanela - mediaJanela);
        const piores = linhas
          .filter((x) => x.deficit > 0.5)
          .sort((a, b) => b.deficit - a.deficit)
          .slice(0, 10);
        const somaPiores = piores.reduce((a, x) => a + x.deficit, 0);

        const detalhe = piores.map((x) => {
          const pct = x.nominal > 0 ? (x.media / x.nominal) * 100 : 0;
          // Arredondar para hora diria "ha 0h" em quem degradou agora.
          const tempo =
            x.horas === null
              ? ''
              : x.horas >= 1
                ? ` · degradada ha ${Math.round(x.horas)}h`
                : ` · degradada ha ${Math.round(x.horas * 60)}min`;
          return (
            `  ${x.nome}  ${x.media.toFixed(0)}/${x.nominal.toFixed(0)} TH` +
            ` (${pct.toFixed(0)}%, -${x.deficit.toFixed(0)})${tempo}`
          );
        });

        avisos.push({
          id: 'cronico',
          texto:
            `🟠 FAZENDA ABAIXO DO NOMINAL HA ${janelaH}H\n\n` +
            `Media de ${janelaH}h: ${mediaJanela.toFixed(0)} TH/s = ${pctJanela.toFixed(1)}% do nominal\n` +
            `Deveria estar:  ${nominalJanela.toFixed(0)} TH/s (limite ${settings.alertFleetPct}%)\n` +
            `Faltando:       ${faltando.toFixed(0)} TH/s\n\n` +
            `${cronicas.length} maquina(s) degradadas ha mais de ${janelaH}h.\n\n` +
            `Quem mais derruba a media:\n${detalhe.join('\n')}\n\n` +
            `Essas ${piores.length} somam ${somaPiores.toFixed(0)} TH/s dos ` +
            `${faltando.toFixed(0)} TH/s que faltam.`,
          textoFim: `🟢 A media de ${janelaH}h da fazenda voltou ao nivel contratado.`,
        });
      }
    }

    if (rows.length > 0 && rows.every((r) => (ciclosParada.get(r.worker) ?? 0) >= 2)) {
      avisos.push({
        id: 'fazenda-parada',
        texto: `🔴 FAZENDA PARADA\nAs ${rows.length} maquinas estao sem produzir.`,
        textoFim: '🟢 Fazenda voltou a produzir.',
      });
    }
    for (const r of rows) {
      const state = (ciclosParada.get(r.worker) ?? 0) >= 2 ? 'offline' : 'online';
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
      persistMonthlyDowntime(mes, inicioMes, Math.min(ts + 1, fimMes), pisosDeParada(settings));
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
