import { createHmac } from 'node:crypto';
import type {
  ViaAccount,
  ViaAccountHashrate,
  ViaChartPoint,
  ViaPayment,
  ViaProfitDay,
  ViaProfitSummary,
  ViaWorker,
} from './types';

const BASE = process.env.VIABTC_BASE_URL || 'https://www.viabtc.net';
const COIN = process.env.VIABTC_COIN || 'BTC';

export class ViaBtcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'ViaBtcError';
  }
}

type Params = Record<string, string | number | boolean | undefined>;

function queryString(params: Params): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * Chamada GET a API da pool. `signed` acrescenta tonce + HMAC-SHA256, exigido
 * apenas pelos endpoints protegidos; os de leitura usados aqui pedem so a chave.
 */
async function get<T>(path: string, params: Params = {}, signed = false): Promise<T> {
  const apiKey = process.env.VIABTC_API_KEY;
  if (!apiKey) throw new ViaBtcError('VIABTC_API_KEY nao configurada no .env.local', -1);

  const finalParams: Params = { ...params };
  const headers: Record<string, string> = { 'X-API-KEY': apiKey, Accept: 'application/json' };

  if (signed) {
    const secret = process.env.VIABTC_SECRET_KEY;
    if (!secret) throw new ViaBtcError('VIABTC_SECRET_KEY nao configurada no .env.local', -1);
    finalParams.tonce = Date.now();
    // A assinatura usa a query string exatamente como enviada, sem encode.
    const raw = Object.entries(finalParams)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    headers['X-SIGNATURE'] = createHmac('sha256', secret).update(raw).digest('hex');
  }

  const qs = queryString(finalParams);
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
  } catch (err) {
    throw new ViaBtcError(
      err instanceof Error && err.name === 'AbortError'
        ? 'Timeout ao falar com a ViaBTC'
        : `Falha de rede: ${(err as Error).message}`,
      -1,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new ViaBtcError(`HTTP ${res.status} em ${path}`, res.status);

  const body = (await res.json()) as { code: number; message: string; data: T };
  if (body.code !== 0) throw new ViaBtcError(translateError(body.code, body.message), body.code);
  return body.data;
}

function translateError(code: number, message: string): string {
  const map: Record<number, string> = {
    2: 'Argumento invalido',
    5001: 'Tipo de moeda invalido',
    5003: 'Maquina nao existe',
    5008: 'Grupo de maquinas nao existe',
    12001: 'Chave de API invalida',
    12002: 'Erro de assinatura',
    12003: 'Tonce invalido — verifique o relogio do sistema',
    12004: 'IP nao autorizado — inclua este IP no whitelist da ViaBTC',
  };
  return map[code] ? `${map[code]} (${code})` : `${message} (${code})`;
}

interface Paged<T> {
  total_page: number;
  total: number;
  has_next: boolean;
  curr_page: number;
  count: number;
  data: T[];
}

export const viabtc = {
  coin: COIN,

  account: () => get<ViaAccount>('/res/openapi/v1/account'),

  accountHashrate: () => get<ViaAccountHashrate>('/res/openapi/v1/hashrate', { coin: COIN }),

  /** Lista todas as maquinas. Pagina automaticamente ate acabar. */
  async workers(): Promise<ViaWorker[]> {
    const out: ViaWorker[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await get<Paged<ViaWorker>>('/res/openapi/v1/hashrate/worker', {
        coin: COIN,
        page,
        limit: 100,
      });
      out.push(...res.data);
      if (!res.has_next) break;
    }
    return out;
  },

  chart: (interval: 'min' | 'hour' | 'day', period = 144) =>
    get<ViaChartPoint[]>('/res/openapi/v1/hashrate/chart', { coin: COIN, interval, period }),

  profitSummary: () => get<ViaProfitSummary>('/res/openapi/v1/profit', { coin: COIN }),

  profitHistory: (limit = 60) =>
    get<Paged<ViaProfitDay>>('/res/openapi/v1/profit/history', { coin: COIN, limit }).then(
      (r) => r.data,
    ),

  paymentHistory: (limit = 60) =>
    get<Paged<ViaPayment>>('/res/openapi/v1/wallet/payment/history', { coin: COIN, limit }).then(
      (r) => r.data,
    ),

  workerHistory: (workerId: number, limit = 30) =>
    get<Paged<{ date: string; coin: string; hashrate: string; reject_rate: string }>>(
      `/res/openapi/v1/hashrate/worker/${workerId}/history`,
      { coin: COIN, limit },
    ).then((r) => r.data),
};

export const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
};

/** H/s -> TH/s */
export const toTh = (v: string | number | null | undefined): number => num(v) / 1e12;
