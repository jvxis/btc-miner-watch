import { kvGet, kvSet } from './db';
import type { CostMode, MinerConfig, Settings } from './types';

const KEY = 'settings';

/**
 * Padroes de partida, ajustaveis na tela de configuracoes.
 * O consumo sai do hashrate nominal x a eficiencia de catalogo do modelo
 * e deve ser ajustado na tela de configuracoes com a medicao real da tomada.
 */
export const DEFAULT_NOMINAL_TH = 191;
export const DEFAULT_J_PER_TH = 21.5;
export const DEFAULT_WATTS = Math.round(DEFAULT_NOMINAL_TH * DEFAULT_J_PER_TH);

export const DEFAULT_SETTINGS: Settings = {
  costModel: 'tariff',
  fixedMonthlyUsdPerMiner: 0,
  tariffBrl: 0.85,
  tariffSurchargePct: 0,
  primaryCurrency: 'BRL',
  alertHashratePct: 85,
  alertRejectPct: 2,
  alertOfflineMinutes: 15,
  alertDegradedMinutes: 60,
  fixedMonthlyCostBrl: 0,
  referenceJPerTh: DEFAULT_J_PER_TH,
  telegramToken: '',
  telegramChatId: '',
  miners: [],
};

export function defaultMiner(worker: string): MinerConfig {
  return {
    worker,
    label: worker,
    nominalTh: DEFAULT_NOMINAL_TH,
    watts: DEFAULT_WATTS,
    costMode: 'inherit',
    tariffBrl: null,
    fixedMonthlyUsd: null,
    courtesyDays: 0,
    firstHashAt: null,
    addedAt: null,
    location: '',
    enabled: true,
  };
}

const DIA_MS = 86_400_000;

/**
 * Fim da cortesia da maquina, contado do primeiro hash.
 * Sem primeiro hash registrado nao ha o que contar — sao as maquinas que ja
 * existiam antes deste controle, cobradas normalmente.
 */
export function courtesyEndsAt(m: MinerConfig): number | null {
  if (m.firstHashAt === null) return null;
  return m.firstHashAt + Math.max(0, m.courtesyDays) * DIA_MS;
}

/**
 * Quanto a maquina custa numa competencia, em dolar.
 *
 * Nao se cobra antes de a maquina existir nem durante a cortesia: o mes e
 * rateado pela fracao em que ela ficou de fato faturavel. E o mesmo criterio
 * que o cobrador usa, com uma linha por periodo.
 */
export function minerMonthlyUsd(
  settings: Settings,
  m: MinerConfig,
  monthStart: number,
  monthEnd: number,
): number {
  const cheio = m.fixedMonthlyUsd ?? settings.fixedMonthlyUsdPerMiner;
  const inicio = courtesyEndsAt(m);
  if (inicio === null) return cheio;

  const faturavel = Math.max(0, monthEnd - Math.max(monthStart, inicio));
  return cheio * (faturavel / (monthEnd - monthStart));
}

/** Soma do contrato de todas as maquinas ativas numa competencia. */
export function contractedUsdForMonth(settings: Settings, monthStart: number, monthEnd: number): number {
  return settings.miners
    .filter((m) => m.enabled)
    .filter((m) => effectiveCostMode(settings, m) === 'fixedUsd')
    .reduce((a, m) => a + minerMonthlyUsd(settings, m, monthStart, monthEnd), 0);
}

/** A maquina esta em cortesia neste instante? */
export function inCourtesy(m: MinerConfig, at = Date.now()): boolean {
  const fim = courtesyEndsAt(m);
  return fim !== null && at < fim;
}

export function getSettings(): Settings {
  const stored = kvGet<Partial<Settings>>(KEY)?.value;
  if (!stored) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    miners: (stored.miners ?? []).map((m) => ({ ...defaultMiner(m.worker), ...m })),
  };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = {
    ...getSettings(),
    ...patch,
    miners: patch.miners
      ? patch.miners.map((m) => ({ ...defaultMiner(m.worker), ...m }))
      : getSettings().miners,
  };
  kvSet(KEY, next);
  return next;
}

/**
 * Garante que toda maquina vista na pool exista na configuracao e carimba o
 * primeiro hash.
 *
 * O carimbo so vale para maquinas cadastradas depois deste controle existir
 * (`addedAt` preenchido). As que ja estavam la ficam com `firstHashAt` nulo e
 * seguem sendo cobradas o mes inteiro — carimbar hoje faria o sistema achar
 * que a fazenda inteira entrou agora.
 */
export function syncMiners(workers: { worker: string; hashing: boolean }[]): Settings {
  const current = getSettings();
  const known = new Map(current.miners.map((m) => [m.worker, m]));
  const agora = Date.now();
  let mudou = false;

  const added = workers
    .filter((w) => !known.has(w.worker))
    .map((w) => ({ ...defaultMiner(w.worker), addedAt: agora }));
  if (added.length > 0) mudou = true;

  const atualizados = current.miners.map((m) => {
    const w = workers.find((x) => x.worker === m.worker);
    if (m.firstHashAt === null && m.addedAt !== null && w?.hashing) {
      mudou = true;
      return { ...m, firstHashAt: agora };
    }
    return m;
  });

  if (!mudou) return current;
  const merged = [...atualizados, ...added].sort((a, b) => a.worker.localeCompare(b.worker));
  return saveSettings({ miners: merged });
}

export function minerConfig(settings: Settings, worker: string): MinerConfig {
  return settings.miners.find((m) => m.worker === worker) ?? defaultMiner(worker);
}

/** Tarifa efetiva de uma maquina, ja com o acrescimo percentual aplicado. */
export function effectiveTariff(settings: Settings, m: MinerConfig): number {
  const base = m.tariffBrl ?? settings.tariffBrl;
  return base * (1 + settings.tariffSurchargePct / 100);
}

/** Modelo de custo que vale para a maquina, resolvendo o 'inherit'. */
export function effectiveCostMode(settings: Settings, m: MinerConfig): CostMode {
  return m.costMode === 'inherit' ? settings.costModel : m.costMode;
}

export interface MinerCost {
  dayBrl: number;
  dayUsd: number;
  mode: CostMode;
  /** consumo diario em kWh — sempre informativo, mesmo no modelo de valor fechado */
  kwhDay: number;
  /** true quando o custo nao varia com a tarifa (contrato fechado) */
  fixed: boolean;
}

/**
 * Custo diario de energia de uma maquina.
 * No modelo de valor fechado o gasto e o mesmo esteja a maquina ligada ou nao,
 * e por isso ele continua sendo contabilizado quando o worker cai.
 */
export function minerCost(settings: Settings, m: MinerConfig, usdBrl: number): MinerCost {
  const kwhDay = (m.watts / 1000) * 24;
  const mode = effectiveCostMode(settings, m);

  if (mode === 'fixedUsd') {
    // Em cortesia a maquina consome energia mas nao gera custo.
    const dayUsd = inCourtesy(m) ? 0 : (m.fixedMonthlyUsd ?? settings.fixedMonthlyUsdPerMiner) / 30;
    return { dayBrl: dayUsd * (usdBrl > 0 ? usdBrl : 0), dayUsd, mode, kwhDay, fixed: true };
  }

  const dayBrl = kwhDay * effectiveTariff(settings, m);
  return { dayBrl, dayUsd: usdBrl > 0 ? dayBrl / usdBrl : 0, mode, kwhDay, fixed: false };
}
