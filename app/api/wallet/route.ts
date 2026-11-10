import { NextResponse } from 'next/server';
import { payments, profitDays } from '@/lib/db';
import { dailyCostResolver } from '@/lib/energy';
import { fetchMarket } from '@/lib/market';
import { modosAtivos, poolPrincipal, poolsAtivas, poolsConfiguradas, type PoolAccount } from '@/lib/pools';
import { getSettings, minerCost } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Quantos registros devolver. O padrao continua o de sempre (90 dias, 60
 * pagamentos), mas quem guarda historico proprio — o btc-ops — precisa pedir
 * mais: o banco daqui tem tudo, e so o corte da resposta fazia pagamentos
 * antigos sumirem para o consumidor.
 */
function limitParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(name));
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, max) : fallback;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const daysLimit = limitParam(url, 'days', 90, 3650);
  const paymentsLimit = limitParam(url, 'payments', 60, 5000);
  try {
    const settings = getSettings();
    // Saldo de toda pool com chave: depois da troca, o que sobrou na antiga
    // continua sendo dinheiro da fazenda ate ser pago.
    const pools = poolsConfiguradas();
    const comChave = pools.length > 0 ? pools : poolsAtivas(settings);
    const [contas, resumos, market] = await Promise.all([
      Promise.all(comChave.map((p) => p.account().catch((e: Error) => e))),
      Promise.all(comChave.map((p) => p.profitSummary().catch(() => null))),
      fetchMarket(),
    ]);

    const lidas = contas.filter((c): c is PoolAccount => !(c instanceof Error));
    if (lidas.length === 0) throw contas[0] instanceof Error ? contas[0] : new Error('Nenhuma pool respondeu');
    const principal = lidas.find((c) => c.pool === poolPrincipal(settings).id) ?? lidas[0];

    let days = profitDays(daysLimit);
    if (days.length === 0) {
      // Banco ainda vazio: busca direto da pool.
      days = await poolPrincipal(settings).profitHistory(90).catch(() => []);
    }
    let pays = payments(paymentsLimit);
    if (pays.length === 0) {
      const p = poolPrincipal(settings);
      pays = (await p.paymentHistory(60).catch(() => [])).map((x) => ({
        pool: p.id,
        id: x.id,
        amount: x.amount,
        address: x.address,
        tx: x.tx,
        create_time: x.createdAt,
      }));
    }

    // Custo diario previsto pelo contrato, usado nos meses sem conta lancada.
    const contractDayBrl =
      settings.miners
        .filter((m) => m.enabled)
        .reduce((a, m) => a + minerCost(settings, m, market.usdBrl).dayBrl, 0) +
      settings.fixedMonthlyCostBrl / 30;

    const custoDoDia = dailyCostResolver(days, contractDayBrl, market.btcBrl);
    const daysWithCost = days.map((d) => {
      const c = custoDoDia(d.date);
      return { ...d, costBrl: c.costBrl, costSats: c.costSats, costReal: c.real };
    });

    const somados = resumos.filter((r) => r !== null);
    return NextResponse.json(
      {
        account: {
          pool: principal.pool,
          name: principal.name,
          email: principal.email,
          createdAt: principal.createdAt,
          addresses: principal.addresses,
        },
        // Uma linha por pool, para a tela mostrar onde esta cada saldo.
        accounts: lidas.map((c) => ({ pool: c.pool, name: c.name, balanceBtc: c.balanceBtc })),
        // O que a pool pagou no ultimo dia fechado diz o modo; a API nao tem campo para isso.
        modos: modosAtivos(settings),
        balances: [{ coin: 'BTC', amount: lidas.reduce((s, c) => s + c.balanceBtc, 0) }],
        summary:
          somados.length > 0
            ? {
                total: somados.reduce((s, r) => s + r.total, 0),
                pps: somados.reduce((s, r) => s + r.pps, 0),
                pplns: somados.reduce((s, r) => s + r.pplns, 0),
                solo: somados.reduce((s, r) => s + r.solo, 0),
              }
            : null,
        days: daysWithCost,
        contractDayBrl,
        payments: pays,
        market,
        settings,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro desconhecido' },
      { status: 502 },
    );
  }
}
