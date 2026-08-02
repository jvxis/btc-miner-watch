import { kvGet, kvSet } from './db';
import type { MarketData } from './types';

const CACHE_KEY = 'market';
const TTL_MS = 120_000;

async function json<T>(url: string, timeoutMs = 12_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'miner-watch/1.0' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const HALVING_INTERVAL = 210_000;
const TARGET_BLOCK_SECONDS = 600;

export async function fetchMarket(force = false): Promise<MarketData> {
  const cached = kvGet<MarketData>(CACHE_KEY);
  if (!force && cached && Date.now() - cached.ts < TTL_MS) {
    return { ...cached.value, stale: false };
  }

  const [cg, mpPrices, diff, hashrate, height, fees, mempool] = await Promise.all([
    json<{ bitcoin: { usd: number; brl: number; usd_24h_change: number; brl_24h_change: number } }>(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,brl&include_24hr_change=true',
    ),
    json<{ USD: number; EUR: number }>('https://mempool.space/api/v1/prices'),
    json<{
      progressPercent: number;
      difficultyChange: number;
      estimatedRetargetDate: number;
      remainingBlocks: number;
      previousRetarget: number;
    }>('https://mempool.space/api/v1/difficulty-adjustment'),
    json<{ currentHashrate: number; currentDifficulty: number }>(
      'https://mempool.space/api/v1/mining/hashrate/3d',
    ),
    json<number>('https://mempool.space/api/blocks/tip/height'),
    json<{ fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }>(
      'https://mempool.space/api/v1/fees/recommended',
    ),
    json<{ count: number }>('https://mempool.space/api/mempool'),
  ]);

  const prev = cached?.value;

  const btcUsd = cg?.bitcoin.usd ?? mpPrices?.USD ?? prev?.btcUsd ?? 0;
  // Sem CoinGecko caimos no ultimo cambio conhecido para nao perder o BRL.
  const usdBrl = cg ? cg.bitcoin.brl / cg.bitcoin.usd : (prev?.usdBrl ?? 0);
  const btcBrl = cg?.bitcoin.brl ?? btcUsd * usdBrl;

  const blocksToHalving =
    typeof height === 'number' ? HALVING_INTERVAL - (height % HALVING_INTERVAL) : null;

  const data: MarketData = {
    btcUsd,
    btcBrl,
    usdBrl,
    change24hUsd: cg?.bitcoin.usd_24h_change ?? prev?.change24hUsd ?? 0,
    change24hBrl: cg?.bitcoin.brl_24h_change ?? prev?.change24hBrl ?? 0,
    networkHashrate: hashrate?.currentHashrate ?? prev?.networkHashrate ?? null,
    difficulty: hashrate?.currentDifficulty ?? prev?.difficulty ?? null,
    difficultyChangePct: diff?.difficultyChange ?? prev?.difficultyChangePct ?? null,
    difficultyProgressPct: diff?.progressPercent ?? prev?.difficultyProgressPct ?? null,
    difficultyRemainingBlocks: diff?.remainingBlocks ?? prev?.difficultyRemainingBlocks ?? null,
    difficultyRetargetDate: diff?.estimatedRetargetDate ?? prev?.difficultyRetargetDate ?? null,
    blockHeight: typeof height === 'number' ? height : (prev?.blockHeight ?? null),
    blocksToHalving: blocksToHalving ?? prev?.blocksToHalving ?? null,
    halvingDate:
      blocksToHalving !== null ? Date.now() + blocksToHalving * TARGET_BLOCK_SECONDS * 1000 : (prev?.halvingDate ?? null),
    feeFastest: fees?.fastestFee ?? prev?.feeFastest ?? null,
    feeHalfHour: fees?.halfHourFee ?? prev?.feeHalfHour ?? null,
    feeHour: fees?.hourFee ?? prev?.feeHour ?? null,
    feeEconomy: fees?.economyFee ?? prev?.feeEconomy ?? null,
    mempoolCount: mempool?.count ?? prev?.mempoolCount ?? null,
    updatedAt: Date.now(),
    stale: !cg && !mpPrices,
  };

  if (btcUsd > 0) kvSet(CACHE_KEY, data);
  return data;
}

/** Recompensa atual do bloco em BTC, considerando os halvings ja ocorridos. */
export function blockSubsidy(height: number | null): number {
  if (height === null) return 3.125;
  return 50 / Math.pow(2, Math.floor(height / HALVING_INTERVAL));
}
