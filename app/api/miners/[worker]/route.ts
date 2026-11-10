import { NextResponse } from 'next/server';
import { workerSeries } from '@/lib/db';
import { buildOverview } from '@/lib/metrics';
import { POOLS } from '@/lib/pools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ worker: string }> }) {
  const { worker } = await ctx.params;
  const hours = Number(new URL(req.url).searchParams.get('hours') ?? 24);

  try {
    const overview = await buildOverview();
    const miner = overview.miners.find((m) => m.worker === worker);
    if (!miner) return NextResponse.json({ error: 'Maquina nao encontrada' }, { status: 404 });

    const bucket = hours <= 6 ? 5 : hours <= 48 ? 15 : 60;
    const series = workerSeries(worker, hours, bucket);
    // O historico diario vem da pool onde a maquina esta minerando agora.
    const pool = POOLS[miner.pool];
    const poolDaily = await pool.workerHistory({ id: miner.workerId, name: miner.worker }, 30).catch(() => []);

    return NextResponse.json(
      { miner, series, poolDaily, poolLabel: pool.label, totals: overview.totals, market: overview.market },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro desconhecido' },
      { status: 502 },
    );
  }
}
