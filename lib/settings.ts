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
  fixedMonthlyCostBrl: 0,
  referenceJPerTh: DEFAULT_J_PER_TH,
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
    location: '',
    enabled: true,
  };
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

/** Garante que toda maquina vista na pool exista na configuracao. */
export function syncMiners(workers: string[]): Settings {
  const current = getSettings();
  const known = new Set(current.miners.map((m) => m.worker));
  const added = workers.filter((w) => !known.has(w)).map(defaultMiner);
  if (added.length === 0) return current;
  const merged = [...current.miners, ...added].sort((a, b) => a.worker.localeCompare(b.worker));
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
    const dayUsd = (m.fixedMonthlyUsd ?? settings.fixedMonthlyUsdPerMiner) / 30;
    return { dayBrl: dayUsd * (usdBrl > 0 ? usdBrl : 0), dayUsd, mode, kwhDay, fixed: true };
  }

  const dayBrl = kwhDay * effectiveTariff(settings, m);
  return { dayBrl, dayUsd: usdBrl > 0 ? dayBrl / usdBrl : 0, mode, kwhDay, fixed: false };
}
