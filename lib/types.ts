// Tipos compartilhados entre servidor e cliente.

export interface ViaWorker {
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

export interface ViaAccountHashrate {
  coin: string;
  hashrate_10min: string;
  hashrate_1hour: string;
  hashrate_24hour: string;
  active_workers: number;
  unactive_workers: number;
}

export interface ViaProfitSummary {
  coin: string;
  total_profit: string;
  pps_profit: string;
  pplns_profit: string;
  solo_profit: string;
}

export interface ViaProfitDay {
  date: string;
  coin: string;
  pps_profit: string;
  pplns_profit: string;
  solo_profit: string;
  total_profit: string;
}

export interface ViaPayment {
  id: number;
  coin: string;
  amount: string;
  address: string;
  tx: string;
  create_time: number;
}

export interface ViaAccount {
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

export interface ViaChartPoint {
  timestamp: number;
  hashrate: string;
  reject_rate: string;
}

// ---------------------------------------------------------------- configuracao

/**
 * Como o custo de energia de uma maquina e apurado.
 * - `tariff`   consumo medido (W) x tarifa por kWh
 * - `fixedUsd` valor fechado por mes em dolar, independente do consumo
 * - `inherit`  segue o modelo global (so existe no nivel da maquina)
 */
export type CostMode = 'tariff' | 'fixedUsd';
export type MinerCostMode = CostMode | 'inherit';

export interface MinerConfig {
  /** worker_name como aparece na pool */
  worker: string;
  /** apelido livre exibido na interface */
  label: string;
  /** hashrate nominal de fabrica, TH/s */
  nominalTh: number;
  /** consumo eletrico na tomada, watts */
  watts: number;
  /** modelo de custo desta maquina; 'inherit' usa o global */
  costMode: MinerCostMode;
  /** tarifa propria em BRL/kWh; null usa a tarifa global */
  tariffBrl: number | null;
  /** custo fechado em USD/mes desta maquina; null usa o valor global */
  fixedMonthlyUsd: number | null;
  /** dias de cortesia a partir do primeiro hash; 0 desliga */
  courtesyDays: number;
  /** quando a maquina apareceu produzindo pela primeira vez */
  firstHashAt: number | null;
  /** quando o worker entrou na configuracao; null nas maquinas antigas, que
   *  existiam antes deste controle e por isso sao cobradas o mes inteiro */
  addedAt: number | null;
  /** local/rack, texto livre */
  location: string;
  enabled: boolean;
}

export interface Settings {
  /** modelo padrao de custo de energia da fazenda */
  costModel: CostMode;
  /** custo fechado padrao por maquina, em USD por mes */
  fixedMonthlyUsdPerMiner: number;
  /** tarifa padrao de energia em BRL por kWh */
  tariffBrl: number;
  /** percentual adicional sobre a conta (impostos, bandeira, ICMS...) */
  tariffSurchargePct: number;
  /** moeda principal exibida nos cartoes */
  primaryCurrency: 'BRL' | 'USD';
  /** limite de hashrate abaixo do nominal que dispara alerta, % */
  alertHashratePct: number;
  /** reject rate acima disso dispara alerta, % */
  alertRejectPct: number;
  /** minutos sem share que marcam a maquina como offline */
  alertOfflineMinutes: number;
  /** minutos degradada seguidos que promovem o aviso de degradacao prolongada */
  alertDegradedMinutes: number;
  /** custo mensal fixo em BRL (aluguel, internet, manutencao) rateado */
  fixedMonthlyCostBrl: number;
  /** eficiencia de referencia J/TH usada no assistente de configuracao */
  referenceJPerTh: number;
  /** avisa no Telegram: criticos e degradacao prolongada. Preencher = ligado */
  telegramToken: string;
  telegramChatId: string;
  miners: MinerConfig[];
}

// ---------------------------------------------------------------- calculados

/** `recovering`: ja voltou a produzir, mas a media de 1h ainda carrega a queda. */
export type MinerStatus = 'online' | 'recovering' | 'degraded' | 'offline';

export interface MinerView {
  workerId: number;
  worker: string;
  label: string;
  location: string;
  status: MinerStatus;
  /** TH/s */
  hashrate10m: number;
  hashrate1h: number;
  /** media 24h calculada do nosso banco (a da pool e inconsistente) */
  hashrate24hLocal: number | null;
  nominalTh: number;
  /** hashrate 1h / nominal, 0..1+ — bom para media, lento para reagir */
  performance: number;
  /** mediana recente do 10min / nominal — base das decisoes de status e alerta */
  performanceRef: number;
  /** mediana recente do hashrate de 10min, TH/s */
  hashrateRef: number;
  rejectPct: number;
  lastActive: number;
  secondsSinceShare: number;
  watts: number;
  kwhDay: number;
  /** J/TH real medido: watts / hashrate 1h */
  efficiency: number;
  costDayBrl: number;
  costDayUsd: number;
  /** modelo efetivamente aplicado a esta maquina */
  costMode: CostMode;
  /** parcela da receita da fazenda atribuida por hashrate */
  revenueDayBtc: number;
  revenueDayBrl: number;
  revenueDayUsd: number;
  profitDayBrl: number;
  profitDayUsd: number;
  marginPct: number;
  /** preco do BTC no qual esta maquina empata */
  breakevenBtcBrl: number;
  /** uptime nas ultimas 24h a partir dos nossos snapshots, % */
  uptime24h: number | null;
  /** nota 0..100 combinando desempenho, rejeicao e uptime */
  health: number;
  /** desde quando esta degradada sem interrupcao; null se nao esta */
  degradedSince: number | null;
  /** desvio percentual frente a mediana da fazenda */
  vsFleetPct: number;
  sparkline: { t: number; h: number }[];
  onlineTime7d: string | null;
  onlineTime30d: string | null;
}

export interface Alert {
  id: string;
  level: 'critical' | 'warning' | 'info';
  worker: string | null;
  title: string;
  detail: string;
  since: number;
}

export interface MarketData {
  btcUsd: number;
  btcBrl: number;
  usdBrl: number;
  change24hUsd: number;
  change24hBrl: number;
  /** hashrate da rede em H/s */
  networkHashrate: number | null;
  difficulty: number | null;
  difficultyChangePct: number | null;
  difficultyProgressPct: number | null;
  difficultyRemainingBlocks: number | null;
  difficultyRetargetDate: number | null;
  blockHeight: number | null;
  blocksToHalving: number | null;
  halvingDate: number | null;
  feeFastest: number | null;
  feeHalfHour: number | null;
  feeHour: number | null;
  feeEconomy: number | null;
  mempoolCount: number | null;
  updatedAt: number;
  stale: boolean;
}

export interface FleetTotals {
  hashrate10m: number;
  hashrate1h: number;
  /** soma das medianas recentes — reage em minutos, nao em 1 hora */
  hashrateRef: number;
  hashrate24hLocal: number | null;
  nominalTh: number;
  performance: number;
  activeWorkers: number;
  inactiveWorkers: number;
  totalWorkers: number;
  rejectPct: number;
  powerKw: number;
  kwhDay: number;
  costDayBrl: number;
  costDayUsd: number;
  /** parcela do custo que nao depende da tarifa (contratos fechados + rateio fixo) */
  costDayFixedBrl: number;
  /** kWh/dia apenas das maquinas cobradas por tarifa — base para simulacoes */
  kwhDayTariffed: number;
  revenueDayBtc: number;
  revenueDayBrl: number;
  revenueDayUsd: number;
  profitDayBrl: number;
  profitDayUsd: number;
  marginPct: number;
  /** J/TH medido: potencia ativa sobre o hashrate de referencia */
  efficiency: number;
  /** J/TH de projeto: potencia instalada sobre o hashrate nominal */
  efficiencyNominal: number;
  /** Visao em satoshis: a receita nasce em sats e o custo e fixo em dolar,
   *  entao o custo em sats cai quando o bitcoin sobe. */
  revenueDaySats: number;
  costDaySats: number;
  profitDaySats: number;
  /** quanto do que foi minerado no dia vai para a energia, % */
  burnPct: number;
  /** satoshis por TH/s por dia */
  satsPerThDay: number;
  /** USD por PH/s por dia */
  hashpriceUsd: number;
  breakevenBtcUsd: number;
  breakevenBtcBrl: number;
  /** custo em BRL de cada BTC minerado */
  costPerBtcBrl: number;
  balanceBtc: number;
  balanceBrl: number;
  balanceUsd: number;
  totalProfitBtc: number;
  /** parcela da rede, ppm */
  networkSharePpm: number | null;
  uptime24h: number | null;
}

export interface RevenueDay {
  date: string;
  btc: number;
  brl: number;
  usd: number;
  costBrl: number;
  profitBrl: number;
  /** custo veio da conta paga do mes (true) ou do contrato configurado (false) */
  costReal: boolean;
}

export interface OverviewPayload {
  totals: FleetTotals;
  miners: MinerView[];
  alerts: Alert[];
  market: MarketData;
  chart: { t: number; h: number; reject: number }[];
  revenueHistory: RevenueDay[];
  settings: Settings;
  poolStatus: { ok: boolean; message: string; lastSuccess: number | null };
  generatedAt: number;
}
