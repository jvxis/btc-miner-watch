import { NextResponse } from 'next/server';
import { sendTelegram } from '@/lib/notify';
import { getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Envia uma mensagem de teste com a configuracao gravada. */
export async function POST() {
  const settings = getSettings();
  const r = await sendTelegram(
    settings,
    '✅ MINER-WATCH\nCanal de avisos configurado.\n' +
      `Voce sera avisado de maquina offline, fazenda parada, falha na pool e ` +
      `degradacao acima de ${settings.alertDegradedMinutes} minutos.`,
  );
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
