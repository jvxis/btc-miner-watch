import { energyBills } from './db';

export interface DailyCost {
  costBrl: number;
  costSats: number;
  /** true quando veio de uma conta efetivamente paga, false quando e o contrato */
  real: boolean;
}

/** Dias que o mes de competencia tem, nao os que aparecem no historico. */
function diasNoMes(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * Custo de energia de cada dia do historico.
 *
 * Meses com conta lancada usam o valor efetivamente pago, rateado pelos dias
 * do mes de competencia. Ratear pelos dias presentes no historico parece
 * equivalente, mas quebra no mes corrente: a fatura e do mes inteiro e os dias
 * ja registrados sao poucos, o que multiplicava o custo diario.
 *
 * Meses sem conta caem no contrato configurado, que segue sendo a melhor
 * estimativa disponivel.
 */
export function dailyCostResolver(
  days: { date: string }[],
  contractDayBrl: number,
  btcBrl: number,
): (date: string) => DailyCost {
  const bills = new Map(energyBills().map((b) => [b.month, b.sats]));
  const contractSats = btcBrl > 0 ? (contractDayBrl / btcBrl) * 1e8 : 0;

  return (date: string): DailyCost => {
    const month = date.slice(0, 7);
    const sats = bills.get(month);

    if (sats && sats > 0) {
      const costSats = sats / diasNoMes(month);
      return { costBrl: (costSats / 1e8) * btcBrl, costSats, real: true };
    }
    return { costBrl: contractDayBrl, costSats: contractSats, real: false };
  };
}
