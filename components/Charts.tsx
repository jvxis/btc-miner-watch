'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtBrl, fmtHash, fmtUsd } from '@/lib/format';

const AXIS = { stroke: 'rgb(var(--phos) / 0.35)', fontSize: 10 };

function TermTooltip({
  active,
  payload,
  label,
  rows,
}: {
  active?: boolean;
  payload?: { payload: Record<string, number | string> }[];
  label?: string | number;
  rows: (d: Record<string, number | string>) => [string, string][];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="panel px-2 py-1.5 text-[0.7rem]">
      <div className="dim mb-1">{String(label)}</div>
      {rows(d).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4">
          <span className="dim">{k}</span>
          <span className="hot">{v}</span>
        </div>
      ))}
    </div>
  );
}

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Hashrate da fazenda ao longo do tempo, com linha do nominal. */
export function HashrateChart({
  data,
  nominal,
  height = 240,
}: {
  data: { t: number; h: number; reject: number }[];
  nominal?: number;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gHash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--phos))" stopOpacity={0.45} />
            <stop offset="100%" stopColor="rgb(var(--phos))" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="t" tickFormatter={hhmm} {...AXIS} minTickGap={40} />
        <YAxis
          {...AXIS}
          width={52}
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}P` : `${v.toFixed(0)}T`)}
        />
        {nominal !== undefined && (
          <ReferenceLine
            y={nominal}
            stroke="rgb(var(--phos) / 0.45)"
            strokeDasharray="4 4"
            label={{ value: 'NOMINAL', position: 'insideTopRight', fill: 'rgb(var(--phos) / 0.6)', fontSize: 9 }}
          />
        )}
        <Tooltip
          content={
            <TermTooltip
              rows={(d) => [
                ['Hashrate', fmtHash(Number(d.h))],
                ['Rejeicao', `${Number(d.reject).toFixed(3)}%`],
              ]}
            />
          }
          labelFormatter={(t) => new Date(Number(t)).toLocaleString('pt-BR')}
        />
        <Area
          type="monotone"
          dataKey="h"
          stroke="rgb(var(--phos))"
          strokeWidth={1.6}
          fill="url(#gHash)"
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Receita diaria x custo de energia, com linha de lucro. */
export function RevenueChart({
  data,
  currency,
  height = 260,
}: {
  data: {
    date: string;
    btc: number;
    brl: number;
    usd: number;
    costBrl: number;
    profitBrl: number;
    costReal?: boolean;
  }[];
  currency: 'BRL' | 'USD';
  height?: number;
}) {
  const fmt = currency === 'BRL' ? fmtBrl : fmtUsd;
  const rate = data.length && data[0].usd > 0 ? data[0].brl / data[0].usd : 1;
  const conv = (brlValue: number) => (currency === 'BRL' ? brlValue : brlValue / rate);
  const rows = data.map((d) => ({
    date: d.date.slice(5),
    receita: conv(d.brl),
    custo: conv(d.costBrl),
    lucro: conv(d.profitBrl),
    btc: d.btc,
    real: d.costReal ? 1 : 0,
  }));
  const temReal = rows.some((r) => r.real === 1);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="date" {...AXIS} minTickGap={16} />
        <YAxis {...AXIS} width={56} tickFormatter={(v: number) => fmt(v, true)} />
        <Tooltip
          content={
            <TermTooltip
              rows={(d) => [
                ['Receita', fmt(Number(d.receita))],
                [
                  temReal ? (d.real === 1 ? 'Energia (conta paga)' : 'Energia (contrato)') : 'Energia',
                  fmt(Number(d.custo)),
                ],
                ['Lucro', fmt(Number(d.lucro))],
                ['Minerado', `${Number(d.btc).toFixed(8)} BTC`],
              ]}
            />
          }
        />
        <Bar dataKey="receita" fill="rgb(var(--phos) / 0.55)" isAnimationActive={false} />
        {/* Barras de custo mais solidas nos meses ja faturados, apagadas quando
            o valor ainda e a estimativa do contrato. */}
        <Bar dataKey="custo" isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.real === 1 ? 'rgb(var(--phos) / 0.34)' : 'rgb(var(--phos) / 0.13)'} />
          ))}
        </Bar>
        <Line
          type="monotone"
          dataKey="lucro"
          stroke="rgb(var(--phos-hot))"
          strokeWidth={1.6}
          dot={false}
          isAnimationActive={false}
        />
        <ReferenceLine y={0} stroke="rgb(var(--crit) / 0.6)" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Resultado por competencia: minerado x energia, com a linha do lucro. */
export function MonthlyPnlChart({
  data,
  height = 280,
}: {
  data: { mes: string; minerado: number; energia: number; lucro: number; estimado: boolean }[];
  height?: number;
}) {
  const sats = (v: number) => `${(v / 1000).toFixed(0)}k`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="mes" {...AXIS} />
        <YAxis {...AXIS} width={52} tickFormatter={sats} />
        <ReferenceLine y={0} stroke="rgb(var(--crit) / 0.6)" />
        <Tooltip
          cursor={{ fill: 'rgb(var(--phos) / 0.06)' }}
          content={
            <TermTooltip
              rows={(d) => [
                ['Minerado', `${Number(d.minerado).toLocaleString('pt-BR')} sats`],
                [
                  d.estimado ? 'Energia (estimada)' : 'Energia',
                  `${Number(d.energia).toLocaleString('pt-BR')} sats`,
                ],
                ['Resultado', `${Number(d.lucro).toLocaleString('pt-BR')} sats`],
              ]}
            />
          }
        />
        <Bar dataKey="minerado" fill="rgb(var(--phos) / 0.55)" isAnimationActive={false} />
        <Bar dataKey="energia" isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.estimado ? 'rgb(var(--phos) / 0.13)' : 'rgb(var(--phos) / 0.34)'} />
          ))}
        </Bar>
        <Line
          type="monotone"
          dataKey="lucro"
          stroke="rgb(var(--phos-hot))"
          strokeWidth={1.8}
          dot={{ r: 2.5, fill: 'rgb(var(--phos-hot))' }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Margem percentual por competencia. */
export function MarginChart({
  data,
  height = 200,
}: {
  data: { mes: string; margem: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="mes" {...AXIS} />
        <YAxis {...AXIS} width={44} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
        <ReferenceLine y={0} stroke="rgb(var(--crit) / 0.6)" />
        <Tooltip
          cursor={{ fill: 'rgb(var(--phos) / 0.06)' }}
          content={<TermTooltip rows={(d) => [['Margem', `${Number(d.margem).toFixed(1)}%`]]} />}
        />
        <Bar dataKey="margem" isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={
                d.margem < 0
                  ? 'rgb(var(--crit) / 0.7)'
                  : d.margem < 25
                    ? 'rgb(var(--warn) / 0.7)'
                    : 'rgb(var(--phos) / 0.6)'
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Resultado acumulado ao longo das competencias. */
export function CumulativeChart({
  data,
  height = 200,
}: {
  data: { mes: string; acumulado: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gAcc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--phos))" stopOpacity={0.4} />
            <stop offset="100%" stopColor="rgb(var(--phos))" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="mes" {...AXIS} />
        <YAxis {...AXIS} width={52} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
        <ReferenceLine y={0} stroke="rgb(var(--crit) / 0.6)" />
        <Tooltip
          content={
            <TermTooltip rows={(d) => [['Acumulado', `${Number(d.acumulado).toLocaleString('pt-BR')} sats`]]} />
          }
        />
        <Area
          type="monotone"
          dataKey="acumulado"
          stroke="rgb(var(--phos))"
          strokeWidth={1.8}
          fill="url(#gAcc)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Ranking horizontal das maquinas por hashrate. */
export function FleetRankChart({
  data,
  nominal,
  height = 420,
}: {
  data: { label: string; value: number; status: string }[];
  nominal: number;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={(v: number) => `${v.toFixed(0)}T`} />
        <YAxis type="category" dataKey="label" {...AXIS} width={78} />
        <ReferenceLine x={nominal} stroke="rgb(var(--phos) / 0.5)" strokeDasharray="4 4" />
        <Tooltip
          cursor={{ fill: 'rgb(var(--phos) / 0.08)' }}
          content={<TermTooltip rows={(d) => [['Hashrate 1h', fmtHash(Number(d.value))]]} />}
        />
        <Bar dataKey="value" isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={
                d.status === 'offline'
                  ? 'rgb(var(--crit) / 0.7)'
                  : d.status === 'degraded'
                    ? 'rgb(var(--warn) / 0.7)'
                    : 'rgb(var(--phos) / 0.6)'
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Serie de uma unica maquina. */
export function MinerChart({
  data,
  nominal,
  height = 260,
}: {
  data: { t: number; h: number; reject: number }[];
  nominal: number;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gMiner" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--phos))" stopOpacity={0.4} />
            <stop offset="100%" stopColor="rgb(var(--phos))" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="t" tickFormatter={hhmm} {...AXIS} minTickGap={40} />
        <YAxis {...AXIS} width={44} tickFormatter={(v: number) => `${v.toFixed(0)}`} />
        <ReferenceLine
          y={nominal}
          stroke="rgb(var(--phos) / 0.45)"
          strokeDasharray="4 4"
          label={{ value: 'NOMINAL', position: 'insideTopRight', fill: 'rgb(var(--phos) / 0.6)', fontSize: 9 }}
        />
        <Tooltip
          labelFormatter={(t) => new Date(Number(t)).toLocaleString('pt-BR')}
          content={
            <TermTooltip
              rows={(d) => [
                ['Hashrate', fmtHash(Number(d.h))],
                ['Rejeicao', `${Number(d.reject).toFixed(3)}%`],
              ]}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="h"
          stroke="rgb(var(--phos))"
          strokeWidth={1.5}
          fill="url(#gMiner)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
