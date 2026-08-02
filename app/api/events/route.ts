import { NextResponse } from 'next/server';
import { recentEvents, snapshotCount } from '@/lib/db';
import { pollStatus } from '@/lib/poller';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    { events: recentEvents(120), samples: snapshotCount(), poller: pollStatus() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
