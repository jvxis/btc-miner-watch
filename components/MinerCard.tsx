import Link from 'next/link';
import { Led, Meter, Sparkline } from './ui';
import { fmtDuration, fmtMoney, fmtPct } from '@/lib/format';
import type { MinerView } from '@/lib/types';

export function MinerCard({ m, currency }: { m: MinerView; currency: 'BRL' | 'USD' }) {
  const tone = m.status === 'offline' ? 'crit' : m.status === 'degraded' ? 'warn' : 'normal';
  const profit = currency === 'BRL' ? m.profitDayBrl : m.profitDayUsd;
  const recuperando = m.status === 'recovering';

  return (
    <Link
      href={`/miners/${encodeURIComponent(m.worker)}`}
      className="panel block p-2.5 transition-colors hover:bg-phos/[0.06]"
    >
      <div className="flex items-center gap-2">
        <Led state={m.status} />
        <span className="truncate text-[0.78rem] hot">{m.label}</span>
        <span
          className={`ml-auto text-[0.7rem] ${
            tone === 'crit' ? 'text-crit blink-crit' : tone === 'warn' ? 'text-warn' : 'dim'
          }`}
          title={`media de 1h: ${fmtPct(m.performance * 100, 0)} do nominal`}
        >
          {m.status === 'offline' ? 'OFFLINE' : fmtPct(m.performanceRef * 100, 0)}
        </span>
      </div>

      <div className="mt-1.5 flex items-end justify-between gap-2">
        <div className="font-display text-2xl leading-none hot">
          {m.hashrate10m.toFixed(1)}
          <span className="ml-1 text-[0.6rem] dim font-mono">TH/s</span>
        </div>
        <Sparkline points={m.sparkline} width={76} height={26} reference={m.nominalTh} />
      </div>

      <div className="mt-2">
        <Meter ratio={m.performanceRef} tone={tone} segments={16} height={7} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2 text-[0.62rem] dim">
        <span>{(m.watts / 1000).toFixed(2)} kW</span>
        <span className="text-right">{m.efficiency > 0 ? `${m.efficiency.toFixed(1)} J/TH` : '—'}</span>
        <span>rej {m.rejectPct.toFixed(2)}%</span>
        <span className={`text-right ${profit < 0 ? 'text-crit' : ''}`}>{fmtMoney(profit, currency, true)}/d</span>
      </div>

      {m.status === 'offline' && (
        <div className="mt-1.5 text-[0.6rem] text-crit">parado ha {fmtDuration(m.secondsSinceShare)}</div>
      )}
      {recuperando && (
        <div className="mt-1.5 text-[0.6rem] dim">
          recuperando · media 1h em {fmtPct(m.performance * 100, 0)}
        </div>
      )}
    </Link>
  );
}
