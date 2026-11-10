'use client';

import { RevenueChart } from '@/components/Charts';
import { EnergyBills } from '@/components/EnergyBills';
import { KeyValue, Meter, Panel, Stat } from '@/components/ui';
import { useOverview, useWallet } from '@/lib/client';
import { fmtBtc, fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtSats } from '@/lib/format';
import { diasFechados, janelaDeReceita, type ModoPagamento } from '@/lib/pools/modo';
import { POOL_LABEL, type PoolId } from '@/lib/pools/types';

interface Day {
  date: string;
  total: number;
  pps: number;
  pplns: number;
  solo: number;
  /** custo de energia do dia, ja resolvido pelo servidor */
  costBrl: number;
  costSats: number;
  /** true quando veio da conta paga do mes */
  costReal: boolean;
}
interface Payment {
  id: number;
  amount: number;
  address: string;
  tx: string;
  create_time: number;
}

/** '2026-01-15' vira '15/01'. */
const diaCurto = (dia: string): string => dia.slice(8, 10) + '/' + dia.slice(5, 7);

export default function WalletPage() {
  const { data, error } = useWallet();
  const { data: overview } = useOverview();

  if (error) return <Panel title="Erro"><p className="text-crit text-sm">{String(error.message)}</p></Panel>;
  if (!data) return <p className="dim caret py-8">CARREGANDO CARTEIRA</p>;

  const market = data.market;
  const cur: 'BRL' | 'USD' = data.settings.primaryCurrency;
  const price = cur === 'BRL' ? market.btcBrl : market.btcUsd;
  const days: Day[] = data.days ?? [];
  const pays: Payment[] = data.payments ?? [];
  const btcBalance = (data.balances as { coin: string; amount: number }[]).find((b) => b.coin === 'BTC')?.amount ?? 0;

  // Custo previsto pelo contrato — base das projecoes, que olham para a frente.
  const dailyCost = data.contractDayBrl ?? overview?.totals.costDayBrl ?? 0;
  const dailyCostCur = cur === 'BRL' ? dailyCost : dailyCost / (market.usdBrl || 1);
  const toCur = (brlValue: number) => (cur === 'BRL' ? brlValue : brlValue / (market.usdBrl || 1));

  // Media dos dias fechados: a janela cresce quando a receita depende de bloco.
  const modos: ModoPagamento[] = data.modos ?? [];
  const closed = diasFechados(days, janelaDeReceita(modos), new Date().toLocaleDateString('sv-SE'));
  const avgBtc = closed.length ? closed.reduce((s, d) => s + d.total, 0) / closed.length : 0;

  const ultimos30 = days.slice(0, 30);
  const btc30 = ultimos30.reduce((s, d) => s + d.total, 0);
  // Custo dos ultimos 30 dias somando o real onde ele existe.
  const cost30Brl = ultimos30.reduce((s, d) => s + d.costBrl, 0);
  const diasReais = ultimos30.filter((d) => d.costReal).length;
  const totalPaid = pays.reduce((s, p) => s + p.amount, 0);

  const history = days
    .slice(0, 45)
    .reverse()
    .map((d) => ({
      date: d.date,
      btc: d.total,
      brl: d.total * market.btcBrl,
      usd: d.total * market.btcUsd,
      costBrl: d.costBrl,
      profitBrl: d.total * market.btcBrl - d.costBrl,
      costReal: d.costReal,
    }));

  const projections = [
    { label: 'Dia', btc: avgBtc },
    { label: 'Semana', btc: avgBtc * 7 },
    { label: 'Mes', btc: avgBtc * 30 },
    { label: 'Ano', btc: avgBtc * 365 },
  ];

  const ppsShare = data.summary && data.summary.total > 0 ? data.summary.pps / data.summary.total : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel title="Saldo na pool">
          <Stat label="Bitcoin" value={fmtBtc(btcBalance)} sub={fmtSats(btcBalance)} size="lg" />
          <div className="mt-2 space-y-0.5">
            <KeyValue k="Em BRL" v={fmtMoney(btcBalance * market.btcBrl, 'BRL')} />
            <KeyValue k="Em USD" v={fmtMoney(btcBalance * market.btcUsd, 'USD')} />
          </div>
        </Panel>

        <Panel title="Receita acumulada">
          <Stat
            label="Total minerado"
            value={fmtBtc(data.summary?.total ?? 0)}
            sub={fmtMoney((data.summary?.total ?? 0) * price, cur, true)}
            size="lg"
          />
          <div className="mt-2">
            <div className="flex justify-between text-[0.64rem]">
              <span className="dim">PPS</span>
              <span className="hot">{fmtPct(ppsShare * 100, 1)}</span>
            </div>
            <div className="mt-1">
              <Meter ratio={ppsShare} segments={20} height={7} />
            </div>
            <div className="mt-2 space-y-0.5">
              {modos.map((m) => (
                <KeyValue
                  key={m.pool}
                  k={modos.length > 1 ? `Ultimo dia pago (${POOL_LABEL[m.pool]})` : 'Ultimo dia pago'}
                  v={`${m.rotulo} (${diaCurto(m.dia)})`}
                  tone={m.modo === 'misto' ? 'warn' : undefined}
                  hint={
                    `${fmtPct(m.fatias.pps, 1)} PPS, ${fmtPct(m.fatias.pplns, 1)} PPLNS, ` +
                    `${fmtPct(m.fatias.solo, 1)} Solo. Neste modo desde ${diaCurto(m.desde)}. ` +
                    'A pool nao informa o modo; uma troca aparece quando ela fecha o primeiro dia no modo novo.'
                  }
                />
              ))}
              <KeyValue k="PPS" v={fmtBtc(data.summary?.pps ?? 0)} />
              <KeyValue k="PPLNS" v={fmtBtc(data.summary?.pplns ?? 0)} />
              <KeyValue k="Solo" v={fmtBtc(data.summary?.solo ?? 0)} />
            </div>
          </div>
        </Panel>

        <Panel title="Ultimos 30 dias">
          <Stat label="Minerado" value={fmtBtc(btc30, 6)} sub={fmtMoney(btc30 * price, cur, true)} size="lg" />
          <div className="mt-2 space-y-0.5">
            <KeyValue
              k={
                diasReais === ultimos30.length && diasReais > 0
                  ? 'Energia (real)'
                  : diasReais > 0
                    ? 'Energia (real + estimada)'
                    : 'Energia (estimada)'
              }
              v={fmtMoney(toCur(cost30Brl), cur, true)}
            />
            <KeyValue
              k="Lucro liquido"
              v={fmtMoney(btc30 * price - toCur(cost30Brl), cur, true)}
              tone={btc30 * price - toCur(cost30Brl) < 0 ? 'crit' : undefined}
            />
            <KeyValue
              k="Dias com registro"
              v={
                diasReais > 0 && diasReais < ultimos30.length
                  ? `${ultimos30.length} · ${diasReais} com conta paga`
                  : String(ultimos30.length)
              }
            />
          </div>
        </Panel>

        <Panel title="Pagamentos">
          <Stat label="Total pago pela pool" value={fmtBtc(totalPaid, 6)} sub={`${pays.length} transacoes`} size="lg" />
          <div className="mt-2 space-y-0.5">
            <KeyValue k="Media por pagamento" v={pays.length ? fmtBtc(totalPaid / pays.length) : '—'} />
            <KeyValue k="Ultimo pagamento" v={pays[0] ? fmtDateTime(pays[0].create_time) : '—'} />
            <KeyValue
              k="Endereco de saque"
              v={<span className="text-[0.6rem]">{data.account.addresses?.[0]?.address?.slice(0, 14) ?? '—'}…</span>}
            />
          </div>
        </Panel>
      </div>

      <Panel title="Projecao de receita" right={`media dos ultimos ${closed.length} dias fechados`}>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {projections.map((p) => {
            const revenue = p.btc * price;
            const costDays = p.label === 'Dia' ? 1 : p.label === 'Semana' ? 7 : p.label === 'Mes' ? 30 : 365;
            const cost = dailyCostCur * costDays;
            return (
              <div key={p.label} className="border border-phos/20 p-3">
                <div className="panel-title">{p.label}</div>
                <div className="font-display text-2xl hot">{fmtBtc(p.btc, 6)}</div>
                <div className="mt-1 space-y-0.5">
                  <KeyValue k="Receita" v={fmtMoney(revenue, cur, true)} />
                  <KeyValue k="Energia" v={fmtMoney(cost, cur, true)} />
                  <KeyValue
                    k="Lucro"
                    v={fmtMoney(revenue - cost, cur, true)}
                    tone={revenue - cost < 0 ? 'crit' : undefined}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[0.62rem] dimmer">
          Projecao a preco de hoje ({fmtMoney(price, cur, true)}/BTC) e dificuldade atual. Cada ajuste de dificuldade e
          cada variacao do cambio muda estes numeros.
        </p>
      </Panel>

      <Panel title="Receita diaria x custo de energia" right={`${history.length} dias`}>
        {history.length > 1 ? (
          <RevenueChart data={history} currency={cur} height={280} />
        ) : (
          <p className="dim text-xs">Sem historico suficiente.</p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[0.62rem] dimmer">
          <span>█ receita paga pela pool</span>
          <span>▓ energia da conta paga do mes, rateada pelos dias</span>
          <span>░ energia estimada pelo contrato</span>
          <span>— lucro liquido</span>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Historico diario da pool" bodyClassName="p-0 max-h-[420px] overflow-auto">
          <table className="term">
            <thead>
              <tr>
                <th>Data</th>
                <th>Total BTC</th>
                <th>PPS</th>
                <th>PPLNS</th>
                <th>Em {cur}</th>
                <th>Energia</th>
                <th>Lucro</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const rev = d.total * price;
                const cost = toCur(d.costBrl);
                const prof = rev - cost;
                return (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className="hot">{fmtBtc(d.total)}</td>
                    <td className="dim">{fmtBtc(d.pps)}</td>
                    <td className="dim">{fmtBtc(d.pplns)}</td>
                    <td>{fmtMoney(rev, cur, true)}</td>
                    <td className={d.costReal ? '' : 'dim'} title={d.costReal ? 'conta paga do mes' : 'contrato configurado'}>
                      {d.costReal ? '' : '≈ '}
                      {fmtMoney(cost, cur, true)}
                    </td>
                    <td className={prof < 0 ? 'text-crit' : ''}>{fmtMoney(prof, cur, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel title="Pagamentos recebidos" bodyClassName="p-0 max-h-[420px] overflow-auto">
          <table className="term">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Valor</th>
                <th>Em {cur}</th>
                <th>Transacao</th>
              </tr>
            </thead>
            <tbody>
              {pays.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDateTime(p.create_time)}</td>
                  <td className="hot">{fmtBtc(p.amount)}</td>
                  <td>{fmtMoney(p.amount * price, cur, true)}</td>
                  <td>
                    <a
                      href={`https://mempool.space/tx/${p.tx}`}
                      target="_blank"
                      rel="noreferrer"
                      className="dim hover:text-[rgb(var(--phos-hot))] hover:underline"
                    >
                      {p.tx.slice(0, 10)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <EnergyBills currency={cur} account={data.account?.name ?? ''} />

      <Panel title="Conta na pool">
        <div className="grid gap-x-8 sm:grid-cols-2">
          <div>
            <KeyValue k="Conta" v={data.account.name} />
            <KeyValue k="E-mail" v={data.account.email ?? '—'} />
            <KeyValue k="Cliente desde" v={data.account.createdAt ? fmtDateTime(data.account.createdAt) : '—'} />
          </div>
          <div>
            {((data.accounts ?? []) as { pool: string; balanceBtc: number }[]).map((a) => (
              <KeyValue
                key={a.pool}
                k={`Saldo ${POOL_LABEL[a.pool as PoolId] ?? a.pool}`}
                v={`${fmtNum(a.balanceBtc, 8)} BTC`}
              />
            ))}
            {(data.accounts ?? []).length > 1 &&
              (data.balances as { coin: string; amount: number }[]).map((b) => (
                <KeyValue key={b.coin} k={`Saldo total ${b.coin}`} v={fmtNum(b.amount, 8)} />
              ))}
          </div>
        </div>
        <div className="mt-2 border-t border-phos/15 pt-2 text-[0.68rem] dim">
          Endereco de saque:{' '}
          <span className="hot break-all">{data.account.addresses?.[0]?.address ?? 'nao configurado'}</span>
        </div>
      </Panel>
    </div>
  );
}
