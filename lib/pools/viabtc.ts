import { createHmac } from 'node:crypto';
import { num, toTh } from './util';
import { PoolError, type PoolProvider } from './types';

const BASE = process.env.VIABTC_BASE_URL || 'https://www.viabtc.net';
const COIN = process.env.VIABTC_COIN || 'BTC';

// ------------------------------------------------------------ formato da ViaBTC

interface ViaWorker {
  worker_id: number;
  worker_name: string;
  group_id: number | null;
  group_name: string | null;
  coin: string;
  hashrate_10min: string;
  hashrate_1hour: string;
  hashrate_24hour: string;
  reject_rate: string;
  online_time_7d?: string;
  online_time_30d?: string;
  online_time_60d?: string;
  online_time_90d?: string;
  last_active: number;
  worker_status: 'active' | 'unactive' | string;
}

interface ViaAccountHashrate {
  coin: string;
  hashrate_10min: string;
  hashrate_1hour: string;
  hashrate_24hour: string;
  active_workers: number;
  unactive_workers: number;
}

interface ViaProfitSummary {
  coin: string;
  total_profit: string;
  pps_profit: string;
  pplns_profit: string;
  solo_profit: string;
}

interface ViaProfitDay {
  date: string;
  coin: string;
  pps_profit: string;
  pplns_profit: string;
  solo_profit: string;
  total_profit: string;
}

interface ViaPayment {
  id: number;
  coin: string;
  amount: string;
  address: string;
  tx: string;
  create_time: number;
}

interface ViaAccount {
  account: {
    id: number;
    parent_user_id: number | null;
    create_time: number;
    account: string;
    email: string | null;
  };
  observer: { id: number; name: string; access_key: string; create_time: number }[];
  withdraw_address: { coin: string; address: string }[];
  balance: { coin: string; amount: string }[];
}

interface ViaChartPoint {
  timestamp: number;
  hashrate: string;
  reject_rate: string;
}

interface Paged<T> {
  total_page: number;
  total: number;
  has_next: boolean;
  curr_page: number;
  count: number;
  data: T[];
}

// ------------------------------------------------------------ transporte

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
  if (!apiKey) throw new PoolError('VIABTC_API_KEY nao configurada no .env.local', -1, 'viabtc');

  const finalParams: Params = { ...params };
  const headers: Record<string, string> = { 'X-API-KEY': apiKey, Accept: 'application/json' };

  if (signed) {
    const secret = process.env.VIABTC_SECRET_KEY;
    if (!secret) throw new PoolError('VIABTC_SECRET_KEY nao configurada no .env.local', -1, 'viabtc');
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
    throw new PoolError(
      err instanceof Error && err.name === 'AbortError'
        ? 'Timeout ao falar com a ViaBTC'
        : `Falha de rede: ${(err as Error).message}`,
      -1,
      'viabtc',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new PoolError(`HTTP ${res.status} em ${path}`, res.status, 'viabtc');

  const body = (await res.json()) as { code: number; message: string; data: T };
  if (body.code !== 0) throw new PoolError(translateError(body.code, body.message), body.code, 'viabtc');
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

// ------------------------------------------------------------ adaptador

export const viabtc: PoolProvider = {
  id: 'viabtc',
  label: 'ViaBTC',
  mempoolSlug: 'viabtc',

  configured: () => Boolean(process.env.VIABTC_API_KEY),

  /** Lista todas as maquinas. Pagina automaticamente ate acabar. */
  async workers() {
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
    return out.map((w) => ({
      id: String(w.worker_id),
      name: w.worker_name,
      pool: 'viabtc' as const,
      h10m: toTh(w.hashrate_10min),
      h1h: toTh(w.hashrate_1hour),
      h24h: toTh(w.hashrate_24hour),
      rejectPct: num(w.reject_rate),
      lastActive: w.last_active * 1000,
      status: w.worker_status,
      online7d: w.online_time_7d ?? null,
      online30d: w.online_time_30d ?? null,
    }));
  },

  async accountHashrate() {
    const a = await get<ViaAccountHashrate>('/res/openapi/v1/hashrate', { coin: COIN });
    return {
      h10m: toTh(a.hashrate_10min),
      h1h: toTh(a.hashrate_1hour),
      h24h: toTh(a.hashrate_24hour),
      active: a.active_workers,
      inactive: a.unactive_workers,
    };
  },

  async account() {
    const a = await get<ViaAccount>('/res/openapi/v1/account');
    return {
      pool: 'viabtc' as const,
      name: a.account.account,
      email: a.account.email,
      createdAt: a.account.create_time * 1000,
      addresses: a.withdraw_address,
      balanceBtc: num(a.balance.find((b) => b.coin === COIN)?.amount ?? 0),
    };
  },

  async profitSummary() {
    const s = await get<ViaProfitSummary>('/res/openapi/v1/profit', { coin: COIN });
    return {
      total: num(s.total_profit),
      pps: num(s.pps_profit),
      pplns: num(s.pplns_profit),
      solo: num(s.solo_profit),
    };
  },

  async profitHistory(days) {
    const r = await get<Paged<ViaProfitDay>>('/res/openapi/v1/profit/history', { coin: COIN, limit: days });
    return r.data.map((p) => ({
      date: p.date,
      total: num(p.total_profit),
      pps: num(p.pps_profit),
      pplns: num(p.pplns_profit),
      solo: num(p.solo_profit),
    }));
  },

  async paymentHistory(limit) {
    const r = await get<Paged<ViaPayment>>('/res/openapi/v1/wallet/payment/history', { coin: COIN, limit });
    return r.data.map((p) => ({
      id: p.id,
      amount: num(p.amount),
      address: p.address,
      tx: p.tx,
      createdAt: p.create_time * 1000,
    }));
  },

  async chart(interval, hours) {
    const period = interval === 'min' ? hours * 6 : hours;
    const pts = await get<ViaChartPoint[]>('/res/openapi/v1/hashrate/chart', { coin: COIN, interval, period });
    return pts.map((p) => ({ ts: p.timestamp * 1000, th: toTh(p.hashrate), rejectPct: num(p.reject_rate) }));
  },

  async workerHistory(worker, days) {
    const r = await get<Paged<{ date: string; coin: string; hashrate: string; reject_rate: string }>>(
      `/res/openapi/v1/hashrate/worker/${worker.id}/history`,
      { coin: COIN, limit: days },
    );
    return r.data.map((d) => ({ date: d.date, th: toTh(d.hashrate), rejectPct: num(d.reject_rate) }));
  },
};
