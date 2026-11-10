import { MONTH_RE, payload } from '@/lib/energyReport';
import { montarPlanilha } from '@/lib/planilha';
import { getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Competencia anterior — e a medicao dela que sustenta o desconto do mes. */
function mesAnterior(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Planilha da fatura, no mesmo formato do extrato em texto.
 *
 * Le o mesmo relatorio que a tela le, entao os dois documentos nao podem
 * divergir: se um numero muda aqui, mudou la tambem.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const month = url.searchParams.get('month') ?? '';
  const conta = (url.searchParams.get('conta') ?? 'nao informada').slice(0, 60);

  if (!MONTH_RE.test(month)) {
    return Response.json({ error: 'Mes invalido — use o formato AAAA-MM' }, { status: 400 });
  }

  try {
    const dados = await payload();
    const anterior = mesAnterior(month);
    const base = dados.bills.find((b) => b.month === anterior)?.downtime ?? null;

    if (!base) {
      return Response.json(
        { error: `Sem medicao de indisponibilidade para ${anterior}: nao ha o que descontar da fatura de ${month}.` },
        { status: 409 },
      );
    }

    const buffer = await montarPlanilha({
      month,
      base,
      baseMonth: anterior,
      contratoUsd: dados.contractedUsdMonth,
      market: dados.market,
      settings: getSettings(),
      conta,
    });

    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="energia-${month}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Erro' }, { status: 500 });
  }
}
