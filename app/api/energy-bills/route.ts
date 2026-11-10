import { NextResponse } from 'next/server';
import { deleteEnergyBill, saveEnergyBill } from '@/lib/db';
import { MONTH_RE, payload } from '@/lib/energyReport';

export async function GET() {
  try {
    return NextResponse.json(await payload(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Erro' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      month?: string;
      sats?: number;
      paidAt?: number | null;
      note?: string;
      minedManual?: number | null;
      invoiceUsd?: number | null;
      creditAppliedUsd?: number | null;
      creditAppliedMonth?: string | null;
      /** move o lancamento de um mes para outro */
      renameFrom?: string;
    };

    if (!body.month || !MONTH_RE.test(body.month)) {
      return NextResponse.json({ error: 'Mes invalido — use o formato AAAA-MM' }, { status: 400 });
    }
    const sats = Number(body.sats);
    if (!Number.isFinite(sats) || sats < 0) {
      return NextResponse.json({ error: 'Valor em satoshis invalido' }, { status: 400 });
    }
    const minedManual =
      body.minedManual === null || body.minedManual === undefined || Number(body.minedManual) <= 0
        ? null
        : Number(body.minedManual);

    const invoiceUsd =
      body.invoiceUsd === null || body.invoiceUsd === undefined || Number(body.invoiceUsd) <= 0
        ? null
        : Number(body.invoiceUsd);

    // Faturar e pagar sao eventos distintos: basta um dos dois para registrar.
    if (sats === 0 && invoiceUsd === null) {
      return NextResponse.json(
        { error: 'Informe a fatura em dolar ou o valor pago em satoshis' },
        { status: 400 },
      );
    }

    const creditAppliedUsd =
      body.creditAppliedUsd === null ||
      body.creditAppliedUsd === undefined ||
      Number(body.creditAppliedUsd) <= 0
        ? null
        : Number(body.creditAppliedUsd);
    const creditAppliedMonth =
      creditAppliedUsd !== null && body.creditAppliedMonth && MONTH_RE.test(body.creditAppliedMonth)
        ? body.creditAppliedMonth
        : null;

    saveEnergyBill({
      month: body.month,
      sats,
      paidAt: body.paidAt ?? null,
      note: (body.note ?? '').slice(0, 200),
      minedManual,
      invoiceUsd,
      creditAppliedUsd,
      creditAppliedMonth,
    });

    if (body.renameFrom && MONTH_RE.test(body.renameFrom) && body.renameFrom !== body.month) {
      deleteEnergyBill(body.renameFrom);
    }

    return NextResponse.json(await payload());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Erro' }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const month = new URL(req.url).searchParams.get('month');
  if (!month || !MONTH_RE.test(month)) {
    return NextResponse.json({ error: 'Mes invalido' }, { status: 400 });
  }
  deleteEnergyBill(month);
  return NextResponse.json(await payload());
}
