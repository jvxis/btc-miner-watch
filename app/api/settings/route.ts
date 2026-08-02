import { NextResponse } from 'next/server';
import { getSettings, saveSettings } from '@/lib/settings';
import type { Settings } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(getSettings(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  try {
    const patch = (await req.json()) as Partial<Settings>;
    return NextResponse.json(saveSettings(patch));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Payload invalido' },
      { status: 400 },
    );
  }
}
