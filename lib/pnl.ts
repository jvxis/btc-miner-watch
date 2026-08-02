// Apuracao do resultado por competencia, compartilhada entre tabela e graficos.

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export const mesLabel = (m: string): string => {
  const [y, mm] = m.split('-');
  return `${MESES[Number(mm) - 1]}/${y.slice(2)}`;
};

export type CostSource = 'pago' | 'faturado' | 'estimado' | 'nenhum';

export interface BillLike {
  month: string;
  satsPaid: number;
  minedSats: number;
  partial: boolean;
  /** custo ja resolvido pelo servidor: pago > faturado > estimado */
  costSats: number;
  costSource: CostSource;
  costUsd: number;
  kwhMonth: number;
  usdPerKwh: number | null;
  brlPerKwh: number | null;
  downtime: { combinedCreditSats: number } | null;
}

export interface Linha {
  month: string;
  partial: boolean;
  minedSats: number;
  /** custo bruto, na melhor fonte disponivel */
  energiaSats: number;
  energiaFonte: CostSource;
  /** true so quando o pagamento ja saiu e os sats estao travados */
  energiaReal: boolean;
  descontoSats: number;
  /** energia menos o credito por indisponibilidade */
  energiaLiquidaSats: number;
  lucroSats: number;
  margemPct: number;
  /** preco efetivo da energia na competencia */
  costUsd: number;
  kwhMonth: number;
  usdPerKwh: number | null;
  brlPerKwh: number | null;
}

/**
 * Monta o resultado de cada competencia.
 *
 * Atencao ao mes encerrado sem fatura lancada: ele cai na estimativa do
 * contrato atual, que pode nao valer para um periodo em que o parque era
 * menor. Esses meses ficam marcados como estimados, para que o acumulado
 * realizado possa exclui-los.
 */
export function calcularLinhas(bills: BillLike[]): Linha[] {
  return bills
    .map((b) => {
      const energiaSats = b.costSats;
      const descontoSats = b.downtime?.combinedCreditSats ?? 0;
      const energiaLiquidaSats = Math.max(0, energiaSats - descontoSats);
      const lucroSats = b.minedSats - energiaLiquidaSats;
      return {
        month: b.month,
        partial: b.partial,
        minedSats: b.minedSats,
        energiaSats,
        energiaFonte: b.costSource,
        energiaReal: b.costSource === 'pago',
        descontoSats,
        energiaLiquidaSats,
        lucroSats,
        margemPct: b.minedSats > 0 ? (lucroSats / b.minedSats) * 100 : 0,
        costUsd: b.costUsd,
        kwhMonth: b.kwhMonth,
        usdPerKwh: b.usdPerKwh,
        brlPerKwh: b.brlPerKwh,
      };
    })
    // Competencia sem producao e sem custo nao diz nada.
    .filter((l) => l.minedSats > 0 || l.energiaSats > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
}

export function totalizar(linhas: Linha[]) {
  const minerado = linhas.reduce((a, l) => a + l.minedSats, 0);
  const energia = linhas.reduce((a, l) => a + l.energiaLiquidaSats, 0);
  const desconto = linhas.reduce((a, l) => a + l.descontoSats, 0);
  const lucro = linhas.reduce((a, l) => a + l.lucroSats, 0);
  // Preco medio ponderado: total gasto dividido pelo total consumido, e nao a
  // media dos precos mensais — meses de tamanhos diferentes pesam diferente.
  const custoUsd = linhas.reduce((a, l) => a + l.costUsd, 0);
  const kwh = linhas.reduce((a, l) => a + l.kwhMonth, 0);
  return {
    minerado,
    energia,
    desconto,
    lucro,
    margem: minerado > 0 ? (lucro / minerado) * 100 : 0,
    custoUsd,
    kwh,
    usdPerKwh: kwh > 0 && custoUsd > 0 ? custoUsd / kwh : null,
  };
}
