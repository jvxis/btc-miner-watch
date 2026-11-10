import { createHmac } from 'node:crypto';
import { num, rateToTh } from './util';
import { PoolError, type PoolProvider, type PoolWorker } from './types';

/**
 * AntPool — https://www.antpool.com/userApi
 *
 * Diferencas que importam para quem vem da ViaBTC:
 * - Tudo e POST com formulario, assinado: HMAC-SHA256 de userId + key + nonce,
 *   em hexadecimal maiusculo. O nonce tem que crescer sempre, entao as chamadas
 *   saem uma de cada vez — duas em paralelo podem chegar fora de ordem.
 * - Limite de 600 chamadas a cada 10 minutos por IP, sob pena de bloqueio.
 * - Nenhum endpoint traz a maquina inteira: `userWorkerList` tem o ultimo
 *   share e a media de 1h, `workers` tem a de 10 minutos. Juntamos pelo nome.
 * - Hashrate da conta e das maquinas em MH/s; o grafico, em H/s.
 * - O grafico devolve janelas fixas de 25 pontos e o parametro `date` marca o
 *   FIM da janela, lido como UTC. 24h de pontos de 10
 *   minutos sao seis chamadas.
 */

const BASE = process.env.ANTPOOL_BASE_URL || 'https://antpool.com/api';
const COIN = 'BTC';
const MHS = 1e6;

/**
 * Fuso das datas que a AntPool manda como texto sem fuso ("2026-01-15 12:00:00").
 *
 * O grafico le o parametro de data como UTC, entao partimos de UTC. Se o
 * ultimo share das maquinas aparecer deslocado, corrige-se aqui pelo
 * ambiente (ex.: ANTPOOL_TIME_OFFSET=+08:00) sem mexer no codigo.
 */
const OFFSET = process.env.ANTPOOL_TIME_OFFSET || '+00:00';

const credenciais = () => ({
  key: process.env.ANTPOOL_API_KEY ?? '',
  secret: process.env.ANTPOOL_API_SECRET ?? '',
  userId: process.env.ANTPOOL_USER_ID ?? '',
});

let ultimoNonce = 0;
let fila: Promise<unknown> = Promise.resolve();

async function post<T>(endpoint: string, params: Record<string, string | number> = {}): Promise<T> {
  // Serializa: o nonce so pode crescer na ordem em que a pool recebe.
  const vez = fila.then(() => chamar<T>(endpoint, params));
  fila = vez.catch(() => undefined);
  return vez;
}

async function chamar<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
  const { key, secret, userId } = credenciais();
  if (!key || !secret || !userId) {
    throw new PoolError('ANTPOOL_API_KEY, ANTPOOL_API_SECRET e ANTPOOL_USER_ID precisam estar no .env.local', -1, 'antpool');
  }

  const nonce = Math.max(Date.now(), ultimoNonce + 1);
  ultimoNonce = nonce;
  const signature = createHmac('sha256', secret).update(`${userId}${key}${nonce}`).digest('hex').toUpperCase();
  const body = new URLSearchParams({ key, nonce: String(nonce), signature });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    throw new PoolError(
      err instanceof Error && err.name === 'AbortError'
        ? 'Timeout ao falar com a AntPool'
        : `Falha de rede: ${(err as Error).message}`,
      -1,
      'antpool',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new PoolError(`HTTP ${res.status} em ${endpoint}`, res.status, 'antpool');
  const json = (await res.json()) as { code: number; message: string; data: T };
  if (json.code !== 0) throw new PoolError(`${json.message} (${json.code}) em ${endpoint}`, json.code, 'antpool');
  return json.data;
}

// ------------------------------------------------------------ conversoes

let avisouFuturo = false;

/** Instante da AntPool em epoch ms: numero (s ou ms) ou texto de data. */
export function antTime(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
  }
  const s = String(v).trim();
  const temFuso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const ts = Date.parse(temFuso ? s : `${s.replace(' ', 'T')}${OFFSET}`);
  if (!Number.isFinite(ts)) return 0;
  // Share no futuro e sinal de fuso errado, nao de relogio adiantado.
  if (!avisouFuturo && ts > Date.now() + 5 * 60_000) {
    avisouFuturo = true;
    console.warn(`[miner-watch] AntPool: horario "${s}" caiu no futuro com ANTPOOL_TIME_OFFSET=${OFFSET}; confira o fuso`);
  }
  return ts;
}

/** Rejeicao em %: "0.12%" ja e percentual; numero puro e fracao. */
function rejeicaoPct(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (s.endsWith('%')) return num(s.slice(0, -1));
  return num(s) * 100;
}

/** Tira o prefixo da conta ("conta.maquina" -> "maquina"). */
function nomeCurto(nome: string): string {
  const { userId } = credenciais();
  const prefixo = `${userId}.`.toLowerCase();
  return userId && nome.toLowerCase().startsWith(prefixo) ? nome.slice(prefixo.length) : nome;
}

/** Data UTC no formato que o parametro `date` do grafico entende. */
function fmtUtc(ts: number): string {
  const d = new Date(ts);
  const z = (x: number) => String(x).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ` +
    `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`
  );
}

const unidadeHs = (u: string | undefined): number => {
  const m = (u ?? 'H/s').trim().match(/^([KMGTPE]?)H/i);
  const f: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  return m ? f[m[1].toUpperCase()] : 1;
};

// ------------------------------------------------------------ formato da AntPool

interface Pagina<T> {
  page: number;
  totalPage: number;
  pageSize: number;
  totalRecord: number;
  rows: T[];
}

interface AntWorkerList {
  workerId: string;
  hsLast1h?: string | number;
  hsLast1d?: string | number;
  rejectRatio?: string | number;
  shareLastTime?: string | number;
}

interface AntWorker {
  worker: string;
  last10m?: string | number;
  last1h?: string | number;
  last1d?: string | number;
}

interface AntRecv {
  timestamp: string;
  ppsAmount?: string | number;
  pplnsAmount?: string | number;
  soloAmount?: string | number;
  ppappsAmount?: string | number;
  ppapplnsAmount?: string | number;
  fppsBlockAmount?: string | number;
  fppsFeeAmount?: string | number;
}

interface AntPayout {
  id: number;
  timestamp: string;
  walletAddress: string;
  txId: string;
  amount: string | number;
}

interface AntChart {
  unit?: string;
  poolSpeedBeanList: { date: number; speed: number | string }[];
}

/** Percorre todas as paginas de um endpoint paginado. */
async function todasAsPaginas<T>(
  endpoint: string,
  params: Record<string, string | number>,
  extrair: (data: unknown) => Pagina<T>,
  limite = Infinity,
  pageSize = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20 && out.length < limite; page++) {
    const p = extrair(await post<unknown>(endpoint, { ...params, pageEnable: 1, page, pageSize }));
    out.push(...(p.rows ?? []));
    if (page >= (p.totalPage ?? 0)) break;
  }
  return out.slice(0, limite);
}

// ------------------------------------------------------------ adaptador

export const antpool: PoolProvider = {
  id: 'antpool',
  label: 'AntPool',
  mempoolSlug: 'antpool',

  configured: () => {
    const c = credenciais();
    return Boolean(c.key && c.secret && c.userId);
  },

  async workers() {
    const { userId } = credenciais();
    const lista = await todasAsPaginas<AntWorkerList>(
      'userWorkerList.htm',
      { coinType: COIN, userId, workerStatus: 0 },
      (d) => (d as { result: Pagina<AntWorkerList> }).result,
      Infinity,
      100,
    );
    const curtas = await todasAsPaginas<AntWorker>(
      'workers.htm',
      { coin: COIN, clientUserId: userId },
      (d) => d as Pagina<AntWorker>,
      Infinity,
      100,
    );
    const dez = new Map(curtas.map((w) => [nomeCurto(w.worker), w]));
    const agora = Date.now();

    const out: PoolWorker[] = lista.map((w) => {
      const name = nomeCurto(w.workerId);
      const c = dez.get(name);
      const h10m = rateToTh(c?.last10m, MHS);
      let lastActive = antTime(w.shareLastTime);
      // Sem horario de share mas com hashrate: a producao prova que esta viva.
      // Deixar zero marcaria a maquina como parada desde 1970.
      if (lastActive === 0 && h10m > 0) lastActive = agora;
      return {
        id: w.workerId,
        name,
        pool: 'antpool' as const,
        h10m,
        h1h: w.hsLast1h !== undefined ? rateToTh(w.hsLast1h, MHS) : rateToTh(c?.last1h, MHS),
        h24h: w.hsLast1d !== undefined ? rateToTh(w.hsLast1d, MHS) : rateToTh(c?.last1d, MHS),
        rejectPct: rejeicaoPct(w.rejectRatio),
        lastActive,
        status: h10m > 0 ? 'active' : 'unactive',
        online7d: null,
        online30d: null,
      };
    });

    // Maquina que so aparece na lista curta (raro, mas a pool e quem decide).
    const vistas = new Set(out.map((w) => w.name));
    for (const [name, c] of dez) {
      if (vistas.has(name)) continue;
      const h10m = rateToTh(c.last10m, MHS);
      out.push({
        id: c.worker,
        name,
        pool: 'antpool',
        h10m,
        h1h: rateToTh(c.last1h, MHS),
        h24h: rateToTh(c.last1d, MHS),
        rejectPct: 0,
        lastActive: h10m > 0 ? agora : 0,
        status: h10m > 0 ? 'active' : 'unactive',
        online7d: null,
        online30d: null,
      });
    }
    return out;
  },

  async accountHashrate() {
    const { userId } = credenciais();
    const h = await post<{
      last10m: string;
      last1h: string;
      last1d: string;
      totalWorkers: number;
      activeWorkers: number;
    }>('hashrate.htm', { coin: COIN, userId });
    return {
      h10m: rateToTh(h.last10m, MHS),
      h1h: rateToTh(h.last1h, MHS),
      h24h: rateToTh(h.last1d, MHS),
      active: num(h.activeWorkers),
      inactive: Math.max(0, num(h.totalWorkers) - num(h.activeWorkers)),
    };
  },

  async account() {
    const { userId } = credenciais();
    const a = await post<{ balance: string }>('account.htm', { coin: COIN, userId });
    return {
      pool: 'antpool' as const,
      name: userId,
      email: null,
      createdAt: null,
      addresses: [],
      balanceBtc: num(a.balance),
    };
  },

  async profitSummary() {
    const { userId } = credenciais();
    const a = await post<{ earnTotal: string }>('account.htm', { coin: COIN, userId });
    // A AntPool paga em FPPS: tudo e pagamento por share, como o PPS da ViaBTC.
    const total = num(a.earnTotal);
    return { total, pps: total, pplns: 0, solo: 0 };
  },

  async profitHistory(days) {
    const { userId } = credenciais();
    const rows = await todasAsPaginas<AntRecv>(
      'paymentHistoryV2.htm',
      { coin: COIN, userId, type: 'recv' },
      (d) => d as Pagina<AntRecv>,
      days,
    );
    return rows.map((r) => {
      const pps = num(r.ppsAmount) + num(r.ppappsAmount) + num(r.fppsBlockAmount) + num(r.fppsFeeAmount);
      const pplns = num(r.pplnsAmount) + num(r.ppapplnsAmount);
      const solo = num(r.soloAmount);
      return { date: String(r.timestamp).slice(0, 10), total: pps + pplns + solo, pps, pplns, solo };
    });
  },

  async paymentHistory(limit) {
    const { userId } = credenciais();
    const rows = await todasAsPaginas<AntPayout>(
      'paymentHistoryV2.htm',
      { coin: COIN, userId, type: 'payout' },
      (d) => d as Pagina<AntPayout>,
      limit,
    );
    return rows.map((r) => ({
      id: num(r.id),
      // A pool registra o pagamento como saida, com sinal negativo.
      amount: Math.abs(num(r.amount)),
      address: r.walletAddress,
      tx: r.txId,
      createdAt: antTime(r.timestamp),
    }));
  },

  async chart(interval, hours) {
    const { userId } = credenciais();
    // Cada chamada devolve 25 pontos terminando em `date`.
    const janelaH = interval === 'min' ? 4 : 24;
    const passos = Math.max(1, Math.ceil(hours / janelaH));
    const pontos = new Map<number, { ts: number; th: number; rejectPct: number }>();
    let fim = Date.now();
    for (let i = 0; i < passos; i++) {
      const d = await post<AntChart[]>('userHashrateChart.htm', {
        coinType: COIN,
        userId,
        type: interval === 'min' ? 1 : 2,
        date: fmtUtc(fim),
      });
      const serie = d?.[0];
      const fator = unidadeHs(serie?.unit);
      for (const p of serie?.poolSpeedBeanList ?? []) {
        pontos.set(p.date, { ts: p.date, th: (num(p.speed) * fator) / 1e12, rejectPct: 0 });
      }
      fim -= janelaH * 3_600_000;
    }
    return [...pontos.values()].sort((a, b) => a.ts - b.ts);
  },

  async workerHistory(worker, days) {
    const { userId } = credenciais();
    const d = await post<AntChart[]>('userHashrateChart.htm', {
      coinType: COIN,
      userId,
      userWorkerId: worker.id,
      type: 3,
    });
    const serie = d?.[0];
    const fator = unidadeHs(serie?.unit);
    return (serie?.poolSpeedBeanList ?? [])
      .map((p) => ({
        date: new Date(p.date).toISOString().slice(0, 10),
        th: (num(p.speed) * fator) / 1e12,
        rejectPct: null,
      }))
      .reverse()
      .slice(0, days);
  },
};
