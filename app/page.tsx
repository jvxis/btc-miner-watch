'use client';

import Link from 'next/link';
import { HashrateChart, RevenueChart } from '@/components/Charts';
import { MinerCard } from '@/components/MinerCard';
import { Gauge, KeyValue, Led, Meter, Panel, Stat } from '@/components/ui';
import { useNow, useOverview } from '@/lib/client';
import {
  fmtBtc,
  fmtClock,
  fmtDuration,
  fmtHash,
  fmtHashHs,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtSats,
} from '@/lib/format';
import type { MediaJanela } from '@/lib/types';

/**
 * Media de janela longa, com a cobertura declarada quando ela nao fecha.
 *
 * Uma media de 30 dias montada com 12 dias de coleta nao e uma media de 30
 * dias, e mostrar so o numero convidaria a compara-la com o nominal de hoje
 * como se fosse.
 */
function mediaLonga(m: MediaJanela | null, janelaDias: number): string {
  if (!m) return 'coletando…';
  const parcial = m.days < janelaDias * 0.9;
  return parcial ? `${fmtHash(m.avg)} · ${m.days.toFixed(0)}d` : fmtHash(m.avg);
}

export default function Dashboard() {
  const { data, error, isLoading } = useOverview();
  const now = useNow();

  if (error) {
    return (
      <Panel title="Falha de comunicacao">
        <p className="text-crit text-sm">{String(error.message ?? error)}</p>
        <p className="dim mt-2 text-xs">
          Verifique a chave em .env.local e se o IP desta maquina esta no whitelist da ViaBTC.
        </p>
      </Panel>
    );
  }

  if (!data || isLoading) {
    return (
      <div className="space-y-1 py-10 font-mono text-sm dim">
        <p>MINER-WATCH · INICIALIZANDO…</p>
        <p>CONECTANDO A VIABTC POOL API</p>
        <p>LENDO SENSORES DAS MAQUINAS</p>
        <p className="caret">AGUARDE</p>
      </div>
    );
  }

  const { totals: t, miners, alerts, market, chart, revenueHistory, settings, poolStatus } = data;
  const cur = settings.primaryCurrency;
  const other = cur === 'BRL' ? 'USD' : 'BRL';
  const profit = cur === 'BRL' ? t.profitDayBrl : t.profitDayUsd;
  const profitOther = cur === 'BRL' ? t.profitDayUsd : t.profitDayBrl;
  const revenue = cur === 'BRL' ? t.revenueDayBrl : t.revenueDayUsd;
  const cost = cur === 'BRL' ? t.costDayBrl : t.costDayUsd;
  const priceNow = cur === 'BRL' ? market.btcBrl : market.btcUsd;
  const change = cur === 'BRL' ? market.change24hBrl : market.change24hUsd;
  const offline = miners.filter((m) => m.status === 'offline').length;
  const degraded = miners.filter((m) => m.status === 'degraded').length;
  const recovering = miners.filter((m) => m.status === 'recovering').length;
  const critical = alerts.filter((a) => a.level === 'critical').length;

  return (
    <div className="space-y-4">
      {/* -------------------------------------------------- linha de status */}
      <div className="panel flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 text-[0.68rem]">
        <span className="flex items-center gap-2">
          <Led state={poolStatus.ok ? 'online' : 'offline'} />
          <span className="dim">POOL</span>
          <span className={poolStatus.ok ? 'hot' : 'text-crit'}>{poolStatus.ok ? 'CONECTADA' : 'ERRO'}</span>
        </span>
        <span className="dim">
          LEITURA <span className="hot">{fmtClock(data.generatedAt)}</span>
        </span>
        <span className="dim">
          MAQUINAS <span className="hot">{t.activeWorkers}</span>/{t.totalWorkers}
        </span>
        <span className="dim">
          BTC <span className="hot">{fmtMoney(priceNow, cur, true)}</span>{' '}
          <span className={change < 0 ? 'text-crit' : 'hot'}>
            {change >= 0 ? '▲' : '▼'}
            {Math.abs(change).toFixed(2)}%
          </span>
        </span>
        <span className={`ml-auto ${critical > 0 ? 'text-crit blink-crit' : 'dim'}`}>
          {critical > 0 ? `${critical} ALERTA(S) CRITICO(S)` : 'SEM ALERTAS CRITICOS'}
        </span>
      </div>

      {/* -------------------------------------------------- instrumentos */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Hashrate da fazenda" right={`${t.totalWorkers} maquinas`}>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-around">
            <Gauge
              value={t.hashrate10m}
              max={t.nominalTh * 1.1}
              redline={t.nominalTh}
              label="10 MIN vs NOMINAL"
              readout={(t.hashrate10m / 1000).toFixed(2)}
              unit="PH/S"
              size={200}
            />
            <div className="w-full max-w-[230px] space-y-1">
              <KeyValue k="Agora (10min)" v={fmtHash(t.hashrate10m)} />
              <KeyValue k="Media 1h" v={fmtHash(t.hashrate1h)} />
              <KeyValue
                k="Media 24h (local)"
                v={t.hashrate24hLocal !== null ? fmtHash(t.hashrate24hLocal) : 'coletando…'}
              />
              <KeyValue k="Media 7d" v={mediaLonga(t.hashrate7d, 7)} />
              <KeyValue k="Media 30d" v={mediaLonga(t.hashrate30d, 30)} />
              <KeyValue k="Nominal" v={fmtHash(t.nominalTh)} />
              <div className="pt-2">
                <div className="flex justify-between text-[0.68rem]">
                  <span className="dim">APROVEITAMENTO</span>
                  <span className={t.performance < 0.9 ? 'text-warn' : 'hot'}>{fmtPct(t.performance * 100)}</span>
                </div>
                <div className="mt-1">
                  <Meter ratio={t.performance} tone={t.performance < 0.85 ? 'warn' : 'normal'} segments={28} />
                </div>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Balanco do dia" right={cur}>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Receita / dia" value={fmtMoney(revenue, cur, true)} sub={`${fmtBtc(t.revenueDayBtc)} BTC`} />
            <Stat label="Energia / dia" value={fmtMoney(cost, cur, true)} sub={`${fmtNum(t.kwhDay, 0)} kWh`} />
            <Stat
              label="Lucro / dia"
              value={fmtMoney(profit, cur, true)}
              sub={`${fmtMoney(profitOther, other, true)} · margem ${fmtPct(t.marginPct, 0)}`}
              tone={profit < 0 ? 'crit' : 'normal'}
              size="lg"
            />
            <Stat
              label="Projecao 30 dias"
              value={fmtMoney(profit * 30, cur, true)}
              sub={`${fmtBtc(t.revenueDayBtc * 30, 6)} BTC minerados`}
              tone={profit < 0 ? 'crit' : 'normal'}
              size="lg"
            />
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-[0.68rem]">
              <span className="dim">MARGEM DE LUCRO</span>
              <span className={t.marginPct < 0 ? 'text-crit' : t.marginPct < 25 ? 'text-warn' : 'hot'}>
                {fmtPct(t.marginPct)}
              </span>
            </div>
            <div className="mt-1">
              <Meter
                ratio={Math.max(0, t.marginPct) / 100}
                tone={t.marginPct < 0 ? 'crit' : t.marginPct < 25 ? 'warn' : 'normal'}
                segments={30}
              />
            </div>
            <div className="mt-2 text-[0.62rem] dimmer">
              Break-even do BTC: {fmtMoney(cur === 'BRL' ? t.breakevenBtcBrl : t.breakevenBtcUsd, cur, true)} — abaixo
              disso a energia custa mais que a receita.
            </div>
          </div>
        </Panel>

        <Panel title="Saude da operacao">
          <div className="flex items-start justify-around gap-2">
            <Gauge
              value={Math.max(0, Math.min(40, t.efficiency))}
              max={40}
              redline={t.efficiencyNominal > 0 ? t.efficiencyNominal : 26}
              label="EFICIENCIA MEDIDA"
              readout={t.efficiency > 0 ? t.efficiency.toFixed(1) : '—'}
              unit="J/TH"
              size={155}
              ticks={8}
            />
            <Gauge
              value={t.uptime24h ?? 100}
              max={100}
              label="DISPONIBILIDADE 24H"
              readout={t.uptime24h !== null ? t.uptime24h.toFixed(1) : '—'}
              unit="%"
              size={155}
              ticks={10}
            />
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-center">
            <div>
              <div className="font-display text-2xl hot">
                {miners.length - offline - degraded - recovering}
              </div>
              <div className="text-[0.6rem] dim">NORMAIS</div>
            </div>
            <div title="Ja produzindo, mas a media de 1h ainda carrega a queda">
              <div className={`font-display text-2xl ${recovering ? 'hot' : 'dimmer'}`}>{recovering}</div>
              <div className="text-[0.6rem] dim">RECUPERANDO</div>
            </div>
            <div>
              <div className={`font-display text-2xl ${degraded ? 'text-warn' : 'dimmer'}`}>{degraded}</div>
              <div className="text-[0.6rem] dim">DEGRADADAS</div>
            </div>
            <div>
              <div className={`font-display text-2xl ${offline ? 'text-crit blink-crit' : 'dimmer'}`}>{offline}</div>
              <div className="text-[0.6rem] dim">OFFLINE</div>
            </div>
          </div>
          <div className="mt-2 space-y-0.5 border-t border-phos/15 pt-2">
            <KeyValue
              k="J/TH de projeto"
              v={t.efficiencyNominal > 0 ? `${t.efficiencyNominal.toFixed(2)}` : '—'}
            />
            <KeyValue
              k="Perda por desempenho"
              v={
                t.efficiencyNominal > 0 && t.efficiency > 0
                  ? `+${(((t.efficiency / t.efficiencyNominal) - 1) * 100).toFixed(0)}%`
                  : '—'
              }
              tone={t.efficiency > t.efficiencyNominal * 1.15 ? 'warn' : undefined}
            />
            <KeyValue k="Potencia ativa" v={`${t.powerKw.toFixed(2)} kW`} />
            <KeyValue k="Rejeicao media" v={fmtPct(t.rejectPct, 3)} tone={t.rejectPct > 2 ? 'warn' : undefined} />
            <KeyValue
              k="Fatia da rede"
              v={t.networkSharePpm !== null ? `${t.networkSharePpm.toFixed(1)} ppm` : '—'}
            />
          </div>
        </Panel>
      </div>

      {/* -------------------------------------------------- grafico principal */}
      <Panel
        title="Hashrate — ultimas 24 horas"
        right={
          <Link href="/miners" className="hover:text-[rgb(var(--phos-hot))]">
            ver maquinas →
          </Link>
        }
      >
        <HashrateChart data={chart} nominal={t.nominalTh} height={250} />
      </Panel>

      {/* -------------------------------------------------- visao em satoshis */}
      <Panel
        title="Balanco em satoshis"
        right="a receita nasce em sats, o custo e fixo em dolar"
      >
        <div className="grid gap-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_1.4fr]">
          <Stat label="Minerado / dia" value={fmtNum(t.revenueDaySats)} sub="sats" size="lg" />
          <Stat
            label="Energia / dia"
            value={fmtNum(t.costDaySats)}
            sub={`sats · ${fmtMoney(t.costDayUsd, 'USD')} fixos`}
            size="lg"
          />
          <Stat
            label="Sobra / dia"
            value={fmtNum(t.profitDaySats)}
            sub={`sats · ${fmtNum(t.profitDaySats * 30)} no mes`}
            tone={t.profitDaySats < 0 ? 'crit' : 'normal'}
            size="lg"
          />
          <Stat
            label="Producao consumida"
            value={fmtPct(t.burnPct, 1)}
            sub="da mineracao vai para a energia"
            tone={t.burnPct > 100 ? 'crit' : t.burnPct > 70 ? 'warn' : 'normal'}
            size="lg"
          />
          <div>
            <div className="panel-title">Se o BTC variar, o custo em sats muda</div>
            <div className="mt-2 space-y-1">
              {[-20, 0, 20, 50].map((v) => {
                const preco = market.btcUsd * (1 + v / 100);
                const custo = preco > 0 ? (t.costDayUsd / preco) * 1e8 : 0;
                const sobra = t.revenueDaySats - custo;
                return (
                  <div key={v} className="flex items-baseline justify-between gap-2 text-[0.72rem]">
                    <span className={v === 0 ? 'hot' : 'dim'}>
                      {v === 0 ? 'hoje' : `${v > 0 ? '+' : ''}${v}%`}
                      <span className="dimmer ml-1">{fmtMoney(preco, 'USD', true)}</span>
                    </span>
                    <span className="dim">{fmtNum(custo)} sats</span>
                    <span className={sobra < 0 ? 'text-crit' : 'hot'}>sobra {fmtNum(sobra)}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[0.6rem] dimmer">
              O contrato e fechado em dolar, entao o gasto em satoshis encolhe quando o bitcoin sobe — e a producao
              diaria em sats nao muda com o preco.
            </p>
          </div>
        </div>
      </Panel>

      {/* -------------------------------------------------- economia */}
      <div className="grid gap-4 lg:grid-cols-4">
        <Panel title="Economia da mineracao" className="lg:col-span-2">
          <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <div>
              <KeyValue k="Sats por TH/dia" v={fmtNum(t.satsPerThDay, 0)} />
              <KeyValue k="Hashprice" v={`${fmtMoney(t.hashpriceUsd, 'USD')} /PH/dia`} />
              <KeyValue k="Custo por BTC minerado" v={fmtMoney(t.costPerBtcBrl, 'BRL', true)} />
              <KeyValue k="Custo por TH/dia" v={fmtMoney(t.costDayBrl / Math.max(1, t.hashrate1h), 'BRL')} />
              <KeyValue k="Receita acumulada" v={`${fmtBtc(t.totalProfitBtc)} BTC`} />
            </div>
            <div>
              <KeyValue k="Saldo na pool" v={`${fmtBtc(t.balanceBtc)} BTC`} />
              <KeyValue k="Saldo em BRL" v={fmtMoney(t.balanceBrl, 'BRL', true)} />
              <KeyValue k="Saldo em USD" v={fmtMoney(t.balanceUsd, 'USD', true)} />
              <KeyValue k="Energia mensal" v={`${fmtNum(t.kwhDay * 30, 0)} kWh`} />
              <KeyValue k="Custo mensal" v={fmtMoney(t.costDayBrl * 30, 'BRL', true)} />
            </div>
          </div>
        </Panel>

        <Panel title="Rede Bitcoin" right={market.stale ? 'defasado' : undefined}>
          <div className="space-y-0.5">
            <KeyValue k="Preco BTC" v={fmtMoney(market.btcBrl, 'BRL', true)} />
            <KeyValue k="Preco BTC" v={fmtMoney(market.btcUsd, 'USD', true)} />
            <KeyValue k="Hashrate da rede" v={fmtHashHs(market.networkHashrate)} />
            <KeyValue
              k="Proximo ajuste"
              v={
                market.difficultyChangePct !== null
                  ? `${market.difficultyChangePct > 0 ? '+' : ''}${market.difficultyChangePct.toFixed(2)}%`
                  : '—'
              }
              tone={market.difficultyChangePct !== null && market.difficultyChangePct > 0 ? 'warn' : undefined}
            />
            <KeyValue k="Altura do bloco" v={fmtNum(market.blockHeight ?? 0)} />
            <KeyValue k="Taxa rapida" v={`${market.feeFastest ?? '—'} sat/vB`} />
          </div>
          <div className="mt-2">
            <div className="flex justify-between text-[0.62rem]">
              <span className="dim">EPOCA DE DIFICULDADE</span>
              <span className="hot">{fmtPct(market.difficultyProgressPct ?? 0, 0)}</span>
            </div>
            <div className="mt-1">
              <Meter ratio={(market.difficultyProgressPct ?? 0) / 100} segments={24} height={7} />
            </div>
          </div>
        </Panel>

        <Panel
          title="Alertas"
          right={alerts.length ? `${alerts.length}` : 'nenhum'}
          bodyClassName="max-h-[280px] overflow-y-auto"
        >
          {alerts.length === 0 ? (
            <p className="dim text-xs">Todos os sistemas operando dentro dos parametros.</p>
          ) : (
            <ul className="space-y-2">
              {alerts.slice(0, 25).map((a) => (
                <li
                  key={a.id}
                  className="border-l-2 pl-2"
                  style={{ borderColor: `rgb(var(--${a.level === 'critical' ? 'crit' : 'warn'}))` }}
                >
                  <div className={`text-[0.72rem] ${a.level === 'critical' ? 'text-crit' : 'text-warn'}`}>
                    {a.title}
                  </div>
                  <div className="text-[0.62rem] dim">{a.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* -------------------------------------------------- grade de maquinas */}
      <Panel
        title="Fazenda"
        right={`${fmtHash(t.hashrate10m)} · ${fmtSats(t.revenueDayBtc)}/dia`}
        bodyClassName="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8"
      >
        {miners.map((m) => (
          <MinerCard key={m.worker} m={m} currency={cur} />
        ))}
      </Panel>

      {/* -------------------------------------------------- receita historica */}
      <Panel title="Receita diaria x custo de energia" right={`${revenueHistory.length} dias · ${cur}`}>
        {revenueHistory.length > 1 ? (
          <RevenueChart data={revenueHistory} currency={cur} height={260} />
        ) : (
          <p className="dim text-xs">Aguardando o historico de pagamentos da pool.</p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[0.62rem] dimmer">
          <span>█ receita paga pela pool</span>
          <span>▓ energia da conta paga do mes</span>
          <span>░ energia estimada pelo contrato</span>
          <span>— lucro liquido</span>
          <span className="ml-auto">
            janela do grafico: {fmtDuration(((now || data.generatedAt) - (chart[0]?.t ?? data.generatedAt)) / 1000)}
          </span>
        </div>
      </Panel>
    </div>
  );
}
