import { energyBills } from './db';

export interface DailyCost {
  costBrl: number;
  costSats: number;
  /** true quando veio de uma conta efetivamente paga, false quando e o contrato */
  real: boolean;
}

/**
 * Custo de energia de cada dia do historico.
 *
 * Meses com conta lancada usam o valor efetivamente pago, rateado pelos dias
 * daquele mes que aparecem no historico — assim a soma das barras do periodo
 * bate exatamente com a fatura. Meses sem conta (inclusive o corrente) caem no
 * contrato configurado, que continua sendo a melhor estimativa disponivel.
 */
export function dailyCostResolver(
  days: { date: string }[],
  contractDayBrl: number,
  btcBrl: number,
): (date: string) => DailyCost {
  const bills = new Map(energyBills().map((b) => [b.month, b.sats]));

  const daysPerMonth = new Map<string, number>();
  for (const d of days) {
    const m = d.date.slice(0, 7);
    daysPerMonth.set(m, (daysPerMonth.get(m) ?? 0) + 1);
  }

  const contractSats = btcBrl > 0 ? (contractDayBrl / btcBrl) * 1e8 : 0;

  return (date: string): DailyCost => {
    const month = date.slice(0, 7);
    const sats = bills.get(month);
    const n = daysPerMonth.get(month) ?? 0;

    if (sats && sats > 0 && n > 0) {
      const costSats = sats / n;
      return { costBrl: (costSats / 1e8) * btcBrl, costSats, real: true };
    }
    return { costBrl: contractDayBrl, costSats: contractSats, real: false };
  };
}
