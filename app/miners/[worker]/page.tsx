'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { MinerChart } from '@/components/Charts';
import { Gauge, KeyValue, Led, Meter, Panel, Stat } from '@/components/ui';
import { useMiner, useNow } from '@/lib/client';
import { fmtBtc, fmtDateTime, fmtDuration, fmtHash, fmtMoney, fmtNum, fmtPct, fmtSats } from '@/lib/format';
import type { FleetTotals, MinerView } from '@/lib/types';

const RANGES = [
  { h: 6, label: '6H' },
  { h: 24, label: '24H' },
  { h: 72, label: '3D' },
  { h: 168, label: '7D' },
];

export default function MinerDetail({ params }: { params: Promise<{ worker: string }> }) {
  const { worker } = use(params);
  const [hours, setHours] = useState(24);
  const agora = useNow();
  const { data, error } = useMiner(decodeURIComponent(worker), hours);

  if (error) return <Panel title="Erro"><p className="text-crit text-sm">{String(error.message)}</p></Panel>;
  if (!data) return <p className="dim caret py-8">CARREGANDO {decodeURIComponent(worker)}</p>;

  const m: MinerView = data.miner;
  const t: FleetTotals = data.totals;
  const series: { t: number; h: number; reject: number }[] = data.series ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/miners" className="term-btn">
          ← voltar
        </Link>
        <h1 className="flex items-center gap-2 font-display text-3xl hot">
          <Led state={m.status} />
          {m.label}
        </h1>
        <span className="dim text-[0.7rem]">
          {m.worker} · id {m.workerId}
          {m.location ? ` · ${m.location}` : ''}
        </span>
        <div className="ml-auto flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.h}
              onClick={() => setHours(r.h)}
              className={`term-btn !py-[3px] !px-2 ${hours === r.h ? 'inverse' : ''}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {m.status === 'offline' && (
        <div className="panel border-crit/60 px-3 py-2 text-crit blink-crit text-sm">
          MAQUINA OFFLINE — sem shares ha {fmtDuration(m.secondsSinceShare)}. Perda estimada de{' '}
          {fmtMoney(m.revenueDayBrl, 'BRL')} por dia parado.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-4">
        <Panel title="Desempenho">
          <Gauge
            value={m.hashrate10m}
            max={m.nominalTh * 1.15}
            redline={m.nominalTh}
            label="10 MIN vs NOMINAL"
            readout={m.hashrate10m.toFixed(1)}
            unit="TH/S"
            size={190}
          />
          <div className="mt-2 space-y-0.5">
            <KeyValue k="Media 1h" v={fmtHash(m.hashrate1h)} />
            <KeyValue
              k="Media 24h (local)"
              v={m.hashrate24hLocal !== null ? fmtHash(m.hashrate24hLocal) : 'coletando…'}
            />
            <KeyValue k="Nominal" v={`${m.nominalTh} TH/s`} />
            <KeyValue
              k="vs mediana da fazenda"
              v={`${m.vsFleetPct >= 0 ? '+' : ''}${m.vsFleetPct.toFixed(1)}%`}
              tone={m.vsFleetPct < -10 ? 'warn' : undefined}
            />
          </div>
        </Panel>

        <Panel title="Saude">
          <Gauge
            value={m.health}
            max={100}
            label="INDICE DE SAUDE"
            readout={m.health.toFixed(0)}
            unit="0-100"
            size={190}
          />
          <div className="mt-2 space-y-0.5">
            <KeyValue
              k="Rejeicao"
              v={fmtPct(m.rejectPct, 3)}
              tone={m.rejectPct > 2 ? 'warn' : undefined}
            />
            <KeyValue k="Uptime 24h (local)" v={m.uptime24h !== null ? fmtPct(m.uptime24h) : 'coletando…'} />
            <KeyValue k="Online 7d (pool)" v={m.onlineTime7d ?? '—'} />
            <KeyValue k="Online 30d (pool)" v={m.onlineTime30d ?? '—'} />
            <KeyValue k="Ultimo share" v={`${fmtDuration(m.secondsSinceShare)} atras`} />
            {m.degradedSince !== null && (
              <KeyValue
                k="Degradada ha"
                v={fmtDuration((agora - m.degradedSince) / 1000)}
                tone="warn"
              />
            )}
          </div>
        </Panel>

        <Panel title="Energia">
          <Gauge
            value={Math.min(40, m.efficiency)}
            max={40}
            redline={26}
            label="EFICIENCIA REAL"
            readout={m.efficiency > 0 ? m.efficiency.toFixed(1) : '—'}
            unit="J/TH"
            size={190}
            ticks={8}
          />
          <div className="mt-2 space-y-0.5">
            <KeyValue
              k="Modelo de custo"
              v={m.costMode === 'fixedUsd' ? 'valor fechado (USD/mes)' : 'consumo × tarifa'}
            />
            <KeyValue k="Potencia configurada" v={`${fmtNum(m.watts)} W`} />
            <KeyValue k="Consumo diario" v={`${m.kwhDay.toFixed(1)} kWh`} />
            <KeyValue k="Consumo mensal" v={`${fmtNum(m.kwhDay * 30, 0)} kWh`} />
            <KeyValue k="Custo diario" v={fmtMoney(m.costDayBrl, 'BRL')} />
            <KeyValue k="Custo mensal" v={fmtMoney(m.costDayBrl * 30, 'BRL', true)} />
          </div>
        </Panel>

        <Panel title="Resultado">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Receita/dia" value={fmtMoney(m.revenueDayBrl, 'BRL', true)} sub={fmtSats(m.revenueDayBtc)} />
            <Stat label="Custo/dia" value={fmtMoney(m.costDayBrl, 'BRL', true)} />
            <Stat
              label="Lucro/dia"
              value={fmtMoney(m.profitDayBrl, 'BRL', true)}
              tone={m.profitDayBrl < 0 ? 'crit' : 'normal'}
              sub={fmtMoney(m.profitDayUsd, 'USD', true)}
            />
            <Stat
              label="Lucro/mes"
              value={fmtMoney(m.profitDayBrl * 30, 'BRL', true)}
              tone={m.profitDayBrl < 0 ? 'crit' : 'normal'}
            />
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-[0.66rem]">
              <span className="dim">MARGEM</span>
              <span className={m.marginPct < 0 ? 'text-crit' : 'hot'}>{fmtPct(m.marginPct)}</span>
            </div>
            <div className="mt-1">
              <Meter
                ratio={Math.max(0, m.marginPct) / 100}
                tone={m.marginPct < 0 ? 'crit' : m.marginPct < 25 ? 'warn' : 'normal'}
                segments={24}
              />
            </div>
          </div>
          <div className="mt-3 space-y-0.5 border-t border-phos/15 pt-2">
            <KeyValue k="Receita/dia (BTC)" v={fmtBtc(m.revenueDayBtc)} />
            <KeyValue k="Break-even do BTC" v={fmtMoney(m.breakevenBtcBrl, 'BRL', true)} />
            <KeyValue
              k="Participacao na fazenda"
              v={fmtPct(t.hashrate1h > 0 ? (m.hashrate1h / t.hashrate1h) * 100 : 0, 2)}
            />
          </div>
        </Panel>
      </div>

      <Panel
        title={`Hashrate — ultimas ${hours} horas (coleta local a cada minuto)`}
        right={series.length ? `${series.length} pontos` : 'sem amostras ainda'}
      >
        {series.length > 1 ? (
          <MinerChart data={series} nominal={m.nominalTh} height={280} />
        ) : (
          <p className="dim text-xs">
            O coletor local ainda nao acumulou amostras suficientes para esta janela. Deixe o app rodando — cada minuto
            grava um ponto.
          </p>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Historico diario da pool" right="dado bruto da ViaBTC" bodyClassName="p-0 overflow-x-auto">
          <table className="term">
            <thead>
              <tr>
                <th>Data</th>
                <th>Hashrate reportado</th>
                <th>Rejeicao</th>
              </tr>
            </thead>
            <tbody>
              {(data.poolDaily ?? []).slice(0, 14).map((d: { date: string; hashrate: string; reject_rate: string }) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="hot">{fmtHash(Number(d.hashrate) / 1e12)}</td>
                  <td>{Number(d.reject_rate).toFixed(3)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="p-3 text-[0.62rem] dimmer">
            A ViaBTC agrega este historico de forma inconsistente por maquina (valores muito acima do nominal). Use o
            grafico acima, gerado pelo coletor local, como referencia real.
          </p>
        </Panel>

        <Panel title="Ficha da maquina">
          <div className="space-y-0.5">
            <KeyValue k="Worker na pool" v={m.worker} />
            <KeyValue k="ID" v={String(m.workerId)} />
            <KeyValue k="Local" v={m.location || '—'} />
            <KeyValue k="Status" v={m.status.toUpperCase()} tone={m.status === 'offline' ? 'crit' : m.status === 'degraded' ? 'warn' : undefined} />
            <KeyValue k="Ultimo share em" v={fmtDateTime(m.lastActive)} />
            <KeyValue k="Hashrate nominal" v={`${m.nominalTh} TH/s`} />
            <KeyValue k="Potencia" v={`${fmtNum(m.watts)} W`} />
            <KeyValue k="Eficiencia de catalogo" v={`${(m.watts / m.nominalTh).toFixed(2)} J/TH`} />
            <KeyValue k="Eficiencia medida" v={m.efficiency > 0 ? `${m.efficiency.toFixed(2)} J/TH` : '—'} />
          </div>
          <div className="mt-3 border-t border-phos/15 pt-2">
            <Link href="/settings" className="term-btn inline-block">
              editar parametros desta maquina
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
