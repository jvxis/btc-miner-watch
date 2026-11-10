/**
 * Formato comum das pools.
 *
 * Cada pool fala a propria lingua — unidades, nomes de campo, paginacao,
 * fuso. O adaptador traduz tudo para isto, e o resto do app nunca mais
 * precisa saber de onde o numero veio. Hashrate sempre em TH/s, tempo
 * sempre em epoch ms, rejeicao sempre em %.
 */

export type PoolId = 'viabtc' | 'antpool';

/** O que a configuracao escolhe: uma pool, ou as duas durante a migracao. */
export type PoolChoice = PoolId | 'ambas';

export const POOL_LABEL: Record<PoolId, string> = {
  viabtc: 'ViaBTC',
  antpool: 'AntPool',
};

export class PoolError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly pool: PoolId,
  ) {
    super(message);
    this.name = 'PoolError';
  }
}

export interface PoolWorker {
  /** identificador que a pool usa para o historico desta maquina */
  id: string;
  /** nome curto, sem o prefixo da conta — e a chave em todo o app */
  name: string;
  pool: PoolId;
  h10m: number;
  h1h: number;
  h24h: number;
  rejectPct: number;
  /** ultimo share aceito, epoch ms; 0 quando a pool nao informa */
  lastActive: number;
  /** estado bruto da pool, so para registro — nenhuma decisao usa isto */
  status: string;
  online7d: string | null;
  online30d: string | null;
}

export interface PoolHashrate {
  h10m: number;
  h1h: number;
  h24h: number;
  active: number;
  inactive: number;
}

export interface PoolAccount {
  pool: PoolId;
  name: string;
  email: string | null;
  createdAt: number | null;
  addresses: { coin: string; address: string }[];
  /** saldo ainda nao pago, BTC */
  balanceBtc: number;
}

export interface PoolProfitSummary {
  total: number;
  pps: number;
  pplns: number;
  solo: number;
}

export interface PoolProfitDay {
  date: string;
  total: number;
  pps: number;
  pplns: number;
  solo: number;
}

export interface PoolPayment {
  id: number;
  amount: number;
  address: string;
  tx: string;
  /** epoch ms */
  createdAt: number;
}

export interface PoolChartPoint {
  ts: number;
  th: number;
  rejectPct: number;
}

export interface PoolWorkerDay {
  date: string;
  th: number;
  /** null quando a pool nao informa rejeicao no historico */
  rejectPct: number | null;
}

export interface PoolProvider {
  id: PoolId;
  label: string;
  /** slug do indice por pool do mempool.space, para o card de blocos */
  mempoolSlug: string;
  /** a chave desta pool esta no ambiente? */
  configured(): boolean;
  workers(): Promise<PoolWorker[]>;
  accountHashrate(): Promise<PoolHashrate>;
  account(): Promise<PoolAccount>;
  profitSummary(): Promise<PoolProfitSummary | null>;
  /** dias fechados, do mais recente para o mais antigo */
  profitHistory(days: number): Promise<PoolProfitDay[]>;
  paymentHistory(limit: number): Promise<PoolPayment[]>;
  /** serie da conta; 'min' em pontos de 10 minutos */
  chart(interval: 'min' | 'hour', hours: number): Promise<PoolChartPoint[]>;
  workerHistory(worker: { id: string; name: string }, days: number): Promise<PoolWorkerDay[]>;
}
