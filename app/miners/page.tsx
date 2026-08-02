'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { FleetRankChart } from '@/components/Charts';
import { MinerCard } from '@/components/MinerCard';
import { Led, Meter, Panel, Sparkline, Stat } from '@/components/ui';
import { useOverview } from '@/lib/client';
import { fmtDuration, fmtHash, fmtMoney, fmtPct } from '@/lib/format';
import type { MinerView } from '@/lib/types';

type SortKey = 'worker' | 'hashrate10m' | 'performance' | 'rejectPct' | 'health' | 'profitDayBrl' | 'efficiency';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'worker', label: 'Maquina' },
  { key: 'hashrate10m', label: '10 min' },
  { key: 'performance', label: '% nominal' },
  { key: 'efficiency', label: 'J/TH' },
  { key: 'rejectPct', label: 'Rejeicao' },
  { key: 'health', label: 'Saude' },
  { key: 'profitDayBrl', label: 'Lucro/dia' },
];

export default function MinersPage() {
  const { data, error } = useOverview();
  const [sort, setSort] = useState<SortKey>('worker');
  const [asc, setAsc] = useState(true);
  const [filter, setFilter] = useState<'all' | 'online' | 'recovering' | 'degraded' | 'offline'>('all');
  const [view, setView] = useState<'grid' | 'table'>('table');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    if (!data) return [] as MinerView[];
    let list = data.miners;
    if (filter !== 'all') list = list.filter((m) => m.status === filter);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter(
        (m) => m.worker.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle),
      );
    }
    return [...list].sort((a, b) => {
      const va = a[sort];
      const vb = b[sort];
      const cmp = typeof va === 'string' ? va.localeCompare(String(vb)) : Number(va) - Number(vb);
      return asc ? cmp : -cmp;
    });
  }, [data, sort, asc, filter, q]);

  if (error) return <Panel title="Erro"><p className="text-crit text-sm">{String(error.message)}</p></Panel>;
  if (!data) return <p className="dim caret py-8">CARREGANDO MAQUINAS</p>;

  const cur = data.settings.primaryCurrency;
  const t = data.totals;
  const best = [...data.miners].sort((a, b) => b.hashrate1h - a.hashrate1h)[0];
  const worst = [...data.miners].sort((a, b) => a.hashrate1h - b.hashrate1h)[0];

  const toggleSort = (k: SortKey) => {
    if (k === sort) setAsc(!asc);
    else {
      setSort(k);
      setAsc(k === 'worker');
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <Stat label="Hashrate total" value={fmtHash(t.hashrate10m)} sub={`nominal ${fmtHash(t.nominalTh)}`} />
        </Panel>
        <Panel>
          <Stat
            label="Melhor maquina"
            value={best?.label ?? '—'}
            sub={best ? `${best.hashrate1h.toFixed(1)} TH/s · ${fmtPct(best.performance * 100, 0)}` : ''}
          />
        </Panel>
        <Panel>
          <Stat
            label="Pior maquina"
            value={worst?.label ?? '—'}
            sub={worst ? `${worst.hashrate1h.toFixed(1)} TH/s · ${fmtPct(worst.performance * 100, 0)}` : ''}
            tone={worst && worst.performance < 0.85 ? 'warn' : 'normal'}
          />
        </Panel>
        <Panel>
          <Stat
            label="Consumo da fazenda"
            value={`${t.powerKw.toFixed(1)} kW`}
            sub={`${fmtMoney(cur === 'BRL' ? t.costDayBrl : t.costDayUsd, cur, true)}/dia de energia`}
          />
        </Panel>
      </div>

      <Panel
        title="Controles"
        right={
          <div className="flex items-center gap-2">
            <button className="term-btn !py-[2px] !px-2" onClick={() => setView(view === 'table' ? 'grid' : 'table')}>
              {view === 'table' ? 'GRADE' : 'TABELA'}
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {(['all', 'online', 'recovering', 'degraded', 'offline'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`term-btn !py-[3px] !px-2 ${filter === f ? 'inverse' : ''}`}
              >
                {f === 'all'
                  ? 'TODAS'
                  : f === 'online'
                    ? 'OK'
                    : f === 'recovering'
                      ? 'RECUPERANDO'
                      : f === 'degraded'
                        ? 'DEGRADADAS'
                        : 'OFFLINE'}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filtrar por nome…"
            className="!w-auto min-w-[180px] flex-1"
          />
          <span className="text-[0.68rem] dim">{rows.length} de {data.miners.length}</span>
        </div>
      </Panel>

      {view === 'grid' ? (
        <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {rows.map((m) => (
            <MinerCard key={m.worker} m={m} currency={cur} />
          ))}
        </div>
      ) : (
        <Panel title="Detalhamento por maquina" bodyClassName="p-0 overflow-x-auto">
          <table className="term">
            <thead>
              <tr>
                <th />
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    className="cursor-pointer select-none hover:text-[rgb(var(--phos-hot))]"
                  >
                    {c.label}
                    {sort === c.key && <span className="ml-1">{asc ? '▲' : '▼'}</span>}
                  </th>
                ))}
                <th>Tendencia 6h</th>
                <th>Ultimo share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.worker}>
                  <td>
                    <Led state={m.status} />
                  </td>
                  <td>
                    <Link href={`/miners/${encodeURIComponent(m.worker)}`} className="hot hover:underline">
                      {m.label}
                    </Link>
                    {m.location && <span className="dimmer ml-2 text-[0.65rem]">{m.location}</span>}
                  </td>
                  <td className="hot">{m.hashrate10m.toFixed(1)} TH</td>
                  <td>
                    <div
                      className="flex items-center gap-2"
                      title={`media de 1h: ${fmtPct(m.performance * 100, 0)}`}
                    >
                      <span className={m.status === 'degraded' ? 'text-warn' : ''}>
                        {fmtPct(m.performanceRef * 100, 0)}
                      </span>
                      <div className="w-20">
                        <Meter
                          ratio={m.performanceRef}
                          segments={12}
                          height={6}
                          tone={m.status === 'offline' ? 'crit' : m.status === 'degraded' ? 'warn' : 'normal'}
                        />
                      </div>
                    </div>
                  </td>
                  <td>{m.efficiency > 0 ? m.efficiency.toFixed(1) : '—'}</td>
                  <td className={m.rejectPct > data.settings.alertRejectPct ? 'text-warn' : ''}>
                    {m.rejectPct.toFixed(3)}%
                  </td>
                  <td>
                    <span className={m.health < 60 ? 'text-crit' : m.health < 85 ? 'text-warn' : 'hot'}>
                      {m.health.toFixed(0)}
                    </span>
                  </td>
                  <td className={(cur === 'BRL' ? m.profitDayBrl : m.profitDayUsd) < 0 ? 'text-crit' : ''}>
                    {fmtMoney(cur === 'BRL' ? m.profitDayBrl : m.profitDayUsd, cur, true)}
                  </td>
                  <td>
                    <Sparkline points={m.sparkline} width={90} height={22} reference={m.nominalTh} />
                  </td>
                  <td className="dim">{fmtDuration(m.secondsSinceShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Ranking por hashrate (media 1h)" right={`linha tracejada = ${data.miners[0]?.nominalTh ?? 0} TH/s`}>
        <FleetRankChart
          data={[...data.miners]
            .sort((a, b) => b.hashrate1h - a.hashrate1h)
            .map((m) => ({ label: m.label, value: m.hashrate1h, status: m.status }))}
          nominal={data.miners[0]?.nominalTh ?? 0}
          height={Math.max(260, data.miners.length * 26)}
        />
      </Panel>
    </div>
  );
}
