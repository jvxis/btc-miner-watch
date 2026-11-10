// Tipos compartilhados entre servidor e cliente.

import type { ModoPagamento } from './pools/modo';
import type { PoolChoice, PoolId } from './pools/types';

export type { PoolChoice, PoolId } from './pools/types';

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
  /** quanto a maquina custou, em BRL — base do payback */
  purchaseBrl: number;
  /**
   * Quando esta maquina entrou em operacao.
   *
   * So importa antes de existir snapshot local: dai para tras o rateio da
   * receita nao tem hashrate por maquina e divide entre as que ja estavam
   * ligadas. Vazio significa "desde o inicio da operacao".
   */
  startedAt: number | null;
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
  /**
   * De qual pool o app le. 'ambas' serve a migracao: soma as duas e cada
   * maquina vale pela pool em que entregou share por ultimo.
   */
  pool: PoolChoice;
  /**
   * Workers que a pool lista mas nao sao maquinas da fazenda — um teste de
   * conexao, por exemplo, fica registrado na pool para sempre. Saem da
   * leitura antes de tudo: sem snapshot, sem alerta, sem contrato, sem credito.
   */
  ignoredWorkers: string[];
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
  /** abaixo deste % do nominal somado, a fazenda inteira conta como degradada */
  alertFleetPct: number;
  /**
   * Janela do aviso de problema cronico, em horas.
   *
   * Vale para os dois lados da condicao: a media da fazenda nessa janela e
   * ha quanto tempo a maquina precisa estar degradada para entrar na conta.
   */
  alertChronicHours: number;
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
  /**
   * Quanto da perda por desempenho abaixo do nominal entra na fatura, em %.
   *
   * Nao e medicao, e acordo: a maquina degradada consumiu a energia e entregou
   * menos, e a causa pode estar dos dois lados. Vale o que for combinado.
   */
  performanceSplitPct: number;
  /** primeiro dia de mineracao da fazenda, para o payback alcancar o inicio */
  miningStartedAt: number | null;
  /**
   * Avisar no Telegram cada bloco que a pool encontra.
   *
   * Desligado por padrao: uma pool grande acha mais de dez blocos por dia, e
   * o canal existe para o que precisa de acao. O card da aba Rede mostra o
   * mesmo sem custo de atencao.
   */
  telegramBlocks: boolean;
  /** avisa no Telegram: criticos e degradacao prolongada. Preencher = ligado */
  telegramToken: string;
  telegramChatId: string;
  miners: MinerConfig[];
}

// ---------------------------------------------------------------- calculados

/** `recovering`: ja voltou a produzir, mas a media de 1h ainda carrega a queda. */
export type MinerStatus = 'online' | 'recovering' | 'degraded' | 'offline';

export interface PaybackInfo {
  purchaseBrl: number;
  returnedBrl: number;
  /** satoshis minerados por esta maquina no periodo — o que esta na carteira */
  returnedSats: number;
  /** energia acumulada em dolar, a moeda do contrato */
  energyUsd: number;
  pct: number;
  measuredDays: number;
  from: string | null;
  /** dias em que o rateio usou hashrate real por maquina */
  preciseDays: number;
  /** dias em que a receita foi dividida entre as maquinas ligadas */
  estimatedDays: number;
  profitDayBrl: number;
  daysLeft: number | null;
  etaAt: number | null;
  done: boolean;
}

export interface MinerView {
  workerId: string;
  /** pool em que a maquina entregou share por ultimo */
  pool: PoolId;
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
  /** retorno do investimento; null quando a maquina nao tem preco informado */
  payback: PaybackInfo | null;
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

/** Bloco encontrado pela pool, identificado pela rede e nao pela pool. */
export interface PoolBlock {
  height: number;
  ts: number;
  rewardSats: number;
  feesSats: number;
  txCount: number;
}

/** Quanto a pool tem achado, e que fatia da rede isso representa. */
export interface PoolBlockStats {
  blocks24h: number | null;
  blocks7d: number | null;
  blocksAll: number | null;
  share24hPct: number | null;
  share7dPct: number | null;
  /** hashrate estimado da pool, em H/s */
  hashrate: number | null;
  updatedAt: number;
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

/** Media de uma janela longa, com a cobertura real que a sustenta. */
export interface MediaJanela {
  avg: number;
  /** dias efetivamente coletados dentro da janela */
  days: number;
}

/** Media desde o inicio da operacao, contra o nominal de cada momento. */
export interface MediaDesdeInicio extends MediaJanela {
  /** primeiro ponto com dado — depois do inicio quando a serie nao alcanca */
  from: number;
  /**
   * Hashrate entregue sobre o nominal das maquinas que ja existiam em cada
   * hora. Numa fazenda que cresceu com o tempo, comparar a media com o
   * nominal de hoje daria um numero baixo que nao quer dizer nada.
   */
  pctNominal: number | null;
}

export interface FleetTotals {
  hashrate10m: number;
  hashrate1h: number;
  /** soma das medianas recentes — reage em minutos, nao em 1 hora */
  hashrateRef: number;
  hashrate24hLocal: number | null;
  /** media de 7 dias do hashrate da conta */
  hashrate7d: MediaJanela | null;
  /** media de 30 dias do hashrate da conta */
  hashrate30d: MediaJanela | null;
  /** media desde o inicio da operacao, a partir da serie horaria da pool */
  hashrateDesdeInicio: MediaDesdeInicio | null;
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
  /** de onde o painel esta lendo, e quais pools tem chave configurada */
  pools: {
    escolha: PoolChoice;
    rotulo: string;
    disponiveis: { id: PoolId; label: string; configurada: boolean }[];
    /** modo de pagamento de cada pool ativa, deduzido do que ela pagou */
    modos: ModoPagamento[];
  };
  /** blocos encontrados pela pool, e a fatia dela na rede */
  poolBlocks: { recentes: PoolBlock[]; stats: PoolBlockStats | null };
  generatedAt: number;
}
