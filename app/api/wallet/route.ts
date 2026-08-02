import { NextResponse } from 'next/server';
import { payments, profitDays } from '@/lib/db';
import { dailyCostResolver } from '@/lib/energy';
import { fetchMarket } from '@/lib/market';
import { getSettings, minerCost } from '@/lib/settings';
import { num, viabtc } from '@/lib/viabtc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const [account, summary, market] = await Promise.all([
      viabtc.account(),
      viabtc.profitSummary().catch(() => null),
      fetchMarket(),
    ]);

    // Se o banco ainda esta vazio, busca direto da pool.
    let days = profitDays(90);
    if (days.length === 0) {
      days = (await viabtc.profitHistory(90).catch(() => [])).map((p) => ({
        date: p.date,
        total: num(p.total_profit),
        pps: num(p.pps_profit),
        pplns: num(p.pplns_profit),
        solo: num(p.solo_profit),
      }));
    }
    let pays = payments(60);
    if (pays.length === 0) {
      pays = (await viabtc.paymentHistory(60).catch(() => [])).map((p) => ({
        id: p.id,
        amount: num(p.amount),
        address: p.address,
        tx: p.tx,
        create_time: p.create_time * 1000,
      }));
    }

    // Custo diario previsto pelo contrato, usado nos meses sem conta lancada.
    const settings = getSettings();
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

    return NextResponse.json(
      {
        account: {
          name: account.account.account,
          email: account.account.email,
          createdAt: account.account.create_time * 1000,
          addresses: account.withdraw_address,
        },
        balances: account.balance.map((b) => ({ coin: b.coin, amount: num(b.amount) })),
        summary: summary
          ? {
              total: num(summary.total_profit),
              pps: num(summary.pps_profit),
              pplns: num(summary.pplns_profit),
              solo: num(summary.solo_profit),
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
