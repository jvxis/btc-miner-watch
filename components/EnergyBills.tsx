'use client';

import { useState } from 'react';
import { Meter, Panel, Stat } from '@/components/ui';
import { useEnergyBills } from '@/lib/client';
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtUsd } from '@/lib/format';

type MinedSource = 'diario' | 'pagamentos' | 'manual' | 'nenhum';

interface DowntimeMiner {
  worker: string;
  label: string;
  downHours: number;
  downPct: number;
  monthlyUsd: number;
  creditUsd: number;
  creditBrl: number;
  creditSats: number;
}

interface DowntimeReport {
  since: number;
  measuredPeriods: { from: number; to: number; ms: number }[];
  individualPeriods: { worker: string; label: string; from: number; to: number; ms: number; soloMs: number }[];
  observedFrom: number | null;
  until: number;
  coverageHours: number;
  hoursInMonth: number;
  coveragePct: number;
  miners: DowntimeMiner[];
  totalDownHours: number;
  worstDownHours: number;
  avgDownHours: number;
  affected: number;
  totalCreditUsd: number;
  totalCreditBrl: number;
  totalCreditSats: number;
  fullOutageHours: number;
  importedOutageHours: number;
  importedPeriods: { from: number; to: number; ms: number }[];
  importedFrom: number | null;
  combinedOutageHours: number;
  combinedCreditUsd: number;
  combinedCreditSats: number;
}

interface CostEstimate {
  usd: number;
  brl: number;
  sats: number;
  elapsedDays: number;
  daysInMonth: number;
  fullMonthUsd: number;
  fullMonthSats: number;
}

interface BillView {
  month: string;
  satsPaid: number;
  paidAt: number | null;
  note: string;
  minedSats: number;
  minedSource: MinedSource;
  daysWithData: number;
  paymentsCount: number;
  minedManual: number | null;
  invoiceUsd: number | null;
  invoiceSats: number | null;
  costSource: 'pago' | 'faturado' | 'estimado' | 'nenhum';
  costSats: number;
  cashSats: number;
  creditAppliedUsd: number | null;
  creditAppliedMonth: string | null;
  creditAppliedSats: number;
  creditEarnedSats: number;
  creditGrantedUsd: number;
  creditGrantedSats: number;
  creditSettled: boolean;
  hasRecord: boolean;
  netSats: number;
  burnPct: number | null;
  partial: boolean;
  estimate: CostEstimate | null;
  downtime: DowntimeReport | null;
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const mesLabel = (m: string) => {
  const [y, mm] = m.split('-');
  return `${MESES[Number(mm) - 1]}/${y.slice(2)}`;
};

/** Competencia seguinte — e nela que o cobrador abate as paradas do mes. */
const proximoMes = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const onlyDigits = (v: string) => Number(String(v).replace(/[^\d]/g, '')) || 0;

const FONTE: Record<MinedSource, { label: string; hint: string }> = {
  diario: { label: 'diario', hint: 'somado do historico diario da pool' },
  pagamentos: { label: 'pagamentos', hint: 'somado dos pagamentos recebidos no mes' },
  manual: { label: 'manual', hint: 'valor informado por voce' },
  nenhum: { label: '—', hint: 'sem dado de producao para este mes' },
};

/**
 * Registro do que foi efetivamente pago de energia, em satoshis, mes a mes.
 * O contrato e fechado em dolar, entao o custo em satoshis muda a cada
 * competencia e so o valor lancado aqui reflete o gasto real.
 */
/** Alinha um rotulo com pontilhado, no estilo de extrato impresso. */
const linha = (rotulo: string, valor: string, largura = 30) =>
  `  ${rotulo} ${'.'.repeat(Math.max(2, largura - rotulo.length))} ${valor}`;

const dm = (t: number) =>
  new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const hm = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Extrato de indisponibilidade em texto puro: serve tanto para print quanto
 * para copiar e colar. Evita acentos e caracteres de desenho para nao quebrar
 * em aplicativos de mensagem.
 */
function montarExtrato(
  bill: BillView,
  market: { btcUsd: number; btcBrl: number; usdBrl: number },
  contratoUsd: number,
  conta: string,
): string {
  const L: string[] = [];
  const regua = '='.repeat(56);
  const traco = '  ' + '-'.repeat(52);
  const mes = mesLabel(bill.month);
  const dt = bill.downtime;
  const doMes = dt !== null;

  L.push(regua);
  L.push(' EXTRATO DE INDISPONIBILIDADE - MINER-WATCH');
  L.push(` Competencia: ${mes}${bill.partial ? '  (mes em curso)' : ''}`);
  L.push(` Conta na pool: ${conta}`);
  L.push(` Emitido em: ${dm(Date.now())}`);
  L.push(regua);
  L.push('');

  if (doMes && dt) {
    const custoHora = dt.hoursInMonth > 0 ? contratoUsd / dt.hoursInMonth : 0;
    L.push('CONTRATO DE ENERGIA');
    L.push(linha('Maquinas', String(dt.miners.length)));
    L.push(linha('Custo contratado', `US$ ${contratoUsd.toFixed(2)} / mes`));
    L.push(linha('Horas no mes', dt.hoursInMonth.toFixed(0)));
    L.push(linha('Custo por hora', `US$ ${custoHora.toFixed(4)}`));
    L.push('');

    L.push('PERIODO OBSERVADO');
    L.push(linha('Competencia', `${dm(dt.since)} a ${dm(dt.until)}`));
    L.push(linha('Medicao propria desde', dt.observedFrom ? dm(dt.observedFrom) : 'sem medicao'));
    if (dt.importedFrom) L.push(linha('Historico da pool desde', dm(dt.importedFrom)));
    L.push(linha('Cobertura', `${dt.coverageHours.toFixed(1)}h de ${dt.hoursInMonth.toFixed(0)}h`));
    L.push('');

    const temQueda = dt.importedPeriods.length > 0 || dt.fullOutageHours > 0;
    L.push('QUEDAS TOTAIS DA FAZENDA');
    if (!temQueda) {
      L.push('  Nenhuma registrada no periodo observado.');
    } else {
      for (const p of dt.importedPeriods) {
        L.push(`  ${dm(p.from)} -> ${hm(p.to)}   ${String(Math.round(p.ms / 60000)).padStart(4)} min   (historico da pool)`);
      }
      if (dt.fullOutageHours > 0) {
        L.push(`  ${String(Math.round(dt.fullOutageHours * 60)).padStart(4)} min em quedas medidas pelo coletor`);
      }
      L.push(traco);
      L.push(linha('Total de fazenda parada', `${dt.combinedOutageHours.toFixed(2)} h`));
    }
    L.push('');

    const paradas = dt.miners.filter((m) => m.downHours > 0.01);
    if (paradas.length > 0) {
      L.push('PARADA POR MAQUINA (medida)');
      for (const m of paradas) {
        L.push(
          `  ${m.label.padEnd(12)} ${m.downHours.toFixed(2).padStart(6)} h   ` +
            `US$ ${String(m.monthlyUsd).padStart(4)}/mes   credito US$ ${m.creditUsd.toFixed(3)}`,
        );
      }
      L.push(traco);
      L.push(linha('Horas-maquina paradas', `${dt.totalDownHours.toFixed(2)} h`));
      L.push('');
    }

    L.push('CREDITO REIVINDICADO');
    L.push(linha('Base de calculo', 'horas paradas x custo por hora'));
    L.push(linha('Valor em dolar', `US$ ${dt.combinedCreditUsd.toFixed(2)}`));
    L.push(linha('Valor em real', `R$ ${(dt.combinedCreditUsd * market.usdBrl).toFixed(2)}`));
    L.push(linha('Valor em satoshis', `${dt.combinedCreditSats.toLocaleString('pt-BR')} sats`));
    L.push(linha('Cotacao usada', `BTC = US$ ${market.btcUsd.toLocaleString('pt-BR')}`));
    L.push('');

    if (bill.estimate) {
      L.push('CUSTO DO MES');
      L.push(linha('Acumulado ate agora', `US$ ${bill.estimate.usd.toFixed(2)}`));
      L.push(linha('Projecao do mes fechado', `US$ ${bill.estimate.fullMonthUsd.toFixed(2)}`));
      L.push(
        linha('A pagar apos o credito', `US$ ${(bill.estimate.fullMonthUsd - dt.combinedCreditUsd).toFixed(2)}`),
      );
      L.push('');
    }
  } else {
    L.push('RESUMO DA COMPETENCIA');
    L.push(linha('Energia paga', bill.satsPaid > 0 ? `${bill.satsPaid.toLocaleString('pt-BR')} sats` : 'nao lancada'));
    if (bill.paidAt) L.push(linha('Pago em', dm(bill.paidAt)));
    L.push(linha('Minerado no mes', `${bill.minedSats.toLocaleString('pt-BR')} sats`));
    L.push(linha('Fonte do minerado', FONTE[bill.minedSource].label));
    if (bill.burnPct !== null) L.push(linha('Producao consumida', `${bill.burnPct.toFixed(1)} %`));
    if (bill.satsPaid > 0 && bill.minedSats > 0) {
      L.push(linha('Sobra', `${bill.netSats.toLocaleString('pt-BR')} sats`));
    }
    if (bill.note) L.push(linha('Observacao', bill.note));
    L.push('');
    L.push('  Sem medicao de indisponibilidade para esta competencia:');
    L.push('  o coletor ainda nao estava em operacao no periodo.');
    L.push('');
  }

  L.push('Fonte dos dados: ViaBTC Pool API.');
  L.push('Quedas medidas pelo intervalo entre shares de cada maquina.');
  L.push(regua);
  return L.join('\n');
}

/**
 * Recibo de pagamento para enviar ao cobrador.
 *
 * A fatura vem em dolar e o pagamento sai em satoshis, entao o documento
 * registra a cotacao usada e o horario — a quantidade de sats so vale para
 * aquele instante, e e por isso que ele termina pedindo a invoice.
 */
function montarRecibo(
  month: string,
  invoiceUsd: number,
  market: { btcUsd: number; btcBrl: number; usdBrl: number },
  credito: { abatidoUsd: number | null; abatidoMes: string | null; medicao: DowntimeReport | null },
  conta: string,
): string {
  const sats = Math.round((invoiceUsd / market.btcUsd) * 1e8);
  const L: string[] = [];
  const regua = '='.repeat(52);

  L.push(regua);
  L.push(' PAGAMENTO DE ENERGIA - MINERACAO');
  L.push(` Competencia: ${mesLabel(month)}`);
  L.push(` Conta na pool: ${conta}`);
  L.push(` Emitido em: ${dm(Date.now())}`);
  L.push(regua);
  L.push('');
  L.push('VALOR A PAGAR');
  L.push(linha('Fatura', `US$ ${invoiceUsd.toFixed(2)}`, 26));
  L.push(linha('Cotacao do BTC', `US$ ${Math.round(market.btcUsd).toLocaleString('pt-BR')}`, 26));
  L.push(linha('Equivalente em BRL', `R$ ${(invoiceUsd * market.usdBrl).toFixed(2)}`, 26));
  L.push('');
  L.push(linha('TOTAL EM SATOSHIS', `${sats.toLocaleString('pt-BR')} sats`, 26));
  L.push('');
  L.push(`  Favor enviar uma invoice Lightning de`);
  L.push(`  ${sats.toLocaleString('pt-BR')} satoshis para eu efetuar o pagamento.`);
  L.push('');
  L.push('  Obs.: o valor em satoshis foi convertido pela cotacao');
  L.push('  acima. Se a invoice demorar, o numero muda e eu refaco');
  L.push('  o calculo no momento do pagamento.');
  L.push('');

  // Quando o abatimento ja veio na fatura, e ele que vale — mandar a nossa
  // medicao junto so contradiria o proprio valor que estamos confirmando.
  const dt = credito.medicao;
  if (credito.abatidoUsd && credito.abatidoUsd > 0) {
    L.push('CREDITO JA ABATIDO NESTA FATURA');
    L.push(linha('Valor', `US$ ${credito.abatidoUsd.toFixed(2)}`, 26));
    if (credito.abatidoMes) L.push(linha('Referente a', mesLabel(credito.abatidoMes), 26));
    L.push('');
    L.push('  O valor a pagar acima ja esta liquido deste credito.');
    L.push('');
  } else if (dt && dt.combinedOutageHours > 0) {
    L.push('PARADAS MEDIDAS NESTA COMPETENCIA');
    L.push(linha('Fazenda parada', `${dt.combinedOutageHours.toFixed(2)} h`, 26));
    L.push(linha('Credito equivalente', `US$ ${dt.combinedCreditUsd.toFixed(2)}`, 26));
    L.push(linha('Em satoshis', `${dt.combinedCreditSats.toLocaleString('pt-BR')} sats`, 26));
    L.push('');
    L.push('  Medicao do nosso monitoramento desta competencia,');
    L.push(`  para ser considerada no abatimento da fatura de`);
    L.push(`  ${mesLabel(proximoMes(month))}, conforme combinado.`);
    L.push('');
  }

  L.push(regua);
  return L.join('\n');
}

/**
 * Relatorio de paradas da competencia: eventos com data e hora, detalhe por
 * maquina e o consolidado. E o documento de argumentacao com o cobrador.
 */
function montarRelatorioParadas(month: string, dt: DowntimeReport, conta: string): string {
  const L: string[] = [];
  const regua = '='.repeat(58);
  const traco = '  ' + '-'.repeat(54);
  const hhmm = (t: number) =>
    new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  L.push(regua);
  L.push(' RELATORIO DE PARADAS - MINERACAO');
  L.push(` Competencia: ${mesLabel(month)}`);
  L.push(` Conta na pool: ${conta}`);
  L.push(` Emitido em: ${dm(Date.now())}`);
  L.push(regua);
  L.push('');

  L.push('PERIODO MONITORADO');
  L.push(linha('Competencia', `${dm(dt.since)} a ${dm(dt.until)}`, 28));
  L.push(linha('Medicao propria desde', dt.observedFrom ? dm(dt.observedFrom) : 'sem medicao', 28));
  if (dt.importedFrom) L.push(linha('Historico da pool desde', dm(dt.importedFrom), 28));
  L.push(linha('Cobertura', `${dt.coverageHours.toFixed(1)}h de ${dt.hoursInMonth.toFixed(0)}h do mes`, 28));
  L.push('');

  const eventos = [
    ...dt.importedPeriods.map((p) => ({ ...p, fonte: 'historico da pool' })),
    ...dt.measuredPeriods.map((p) => ({ ...p, fonte: 'medido pelo coletor' })),
  ].sort((a, b) => a.from - b.from);

  L.push(`QUEDAS TOTAIS DA FAZENDA (${eventos.length})`);
  if (eventos.length === 0) {
    L.push('  Nenhuma registrada no periodo.');
  } else {
    for (const e of eventos) {
      L.push(
        `  ${hhmm(e.from)} -> ${new Date(e.to).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` +
          `  ${String(Math.round(e.ms / 60000)).padStart(4)} min   ${e.fonte}`,
      );
    }
    L.push(traco);
    L.push(linha('Total parado', `${dt.combinedOutageHours.toFixed(2)} h`, 28));
  }
  L.push('');

  // Maquina que ficou fora sozinha nao aparece na queda geral e passaria
  // despercebida no meio da tabela de horas.
  if (dt.individualPeriods.length > 0) {
    L.push(`PARADAS INDIVIDUAIS (${dt.individualPeriods.length})`);
    L.push('  Fora dos periodos de queda geral acima.');
    for (const p of dt.individualPeriods) {
      const fim = p.to >= dt.until - 5 * 60_000 ? 'em curso' : hhmm(p.to).slice(-5);
      L.push(
        `  ${p.label.padEnd(13)} ${hhmm(p.from)} -> ${fim.padEnd(8)} ` +
          `${(p.ms / 3_600_000).toFixed(1).padStart(5)}h total, ${(p.soloMs / 3_600_000).toFixed(1).padStart(5)}h sozinha`,
      );
    }
    L.push('');
  }

  const paradas = dt.miners.filter((m) => m.downHours > 0.01);
  if (paradas.length > 0) {
    L.push('DETALHE POR MAQUINA');
    L.push('  maquina        horas    % janela   contrato    credito');
    for (const m of paradas) {
      L.push(
        `  ${m.label.padEnd(13)} ${m.downHours.toFixed(2).padStart(6)}   ${m.downPct.toFixed(1).padStart(6)}%   ` +
          `US$ ${String(m.monthlyUsd).padStart(4)}   US$ ${m.creditUsd.toFixed(3).padStart(7)}`,
      );
    }
    L.push(traco);
    L.push(linha('Horas-maquina paradas', `${dt.totalDownHours.toFixed(2)} h`, 28));
    L.push(linha('Maquinas afetadas', `${dt.affected} de ${dt.miners.length}`, 28));
    L.push('');
  }

  L.push('CREDITO APURADO');
  L.push(linha('Base de calculo', 'horas paradas x custo por hora', 28));
  L.push(linha('Em dolar', `US$ ${dt.combinedCreditUsd.toFixed(2)}`, 28));
  // O combinado nao tem versao em real; derivamos pela proporcao do medido.
  const usdBrl = dt.totalCreditUsd > 0 ? dt.totalCreditBrl / dt.totalCreditUsd : 0;
  if (usdBrl > 0) L.push(linha('Em real', `R$ ${(dt.combinedCreditUsd * usdBrl).toFixed(2)}`, 28));
  L.push(linha('Em satoshis', `${dt.combinedCreditSats.toLocaleString('pt-BR')} sats`, 28));
  L.push('');
  L.push(`  Para ser considerado no abatimento da fatura de`);
  L.push(`  ${mesLabel(proximoMes(month))}, conforme combinado.`);
  L.push('');
  L.push('  Maquina parada nao consome energia. Maquina apenas');
  L.push('  degradada nao entra neste calculo, pois continua');
  L.push('  puxando quase toda a potencia.');
  L.push(regua);
  return L.join('\n');
}

export function EnergyBills({
  currency,
  account = '',
}: {
  currency: 'BRL' | 'USD';
  account?: string;
}) {
  const { data, mutate, isLoading } = useEnergyBills();
  const [month, setMonth] = useState(thisMonth());
  const [sats, setSats] = useState('');
  const [note, setNote] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [minedManual, setMinedManual] = useState('');
  /** mes original quando estamos editando, para mover o lancamento se trocar */
  const [editingFrom, setEditingFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /** o detalhe por maquina sao 16 linhas: fica recolhido por padrao */
  const [verDetalhe, setVerDetalhe] = useState(false);
  /** competencia com extrato aberto */
  const [extratoMes, setExtratoMes] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  /** valor faturado pelo cobrador, em dolar */
  const [faturaUsd, setFaturaUsd] = useState('');
  /** abatimento que o cobrador aplicou nesta fatura, vindo de outra competencia */
  const [abatimentoUsd, setAbatimentoUsd] = useState('');
  const [abatimentoMes, setAbatimentoMes] = useState('');
  const [recibo, setRecibo] = useState<string | null>(null);
  const [reciboCopiado, setReciboCopiado] = useState(false);
  const [relatorio, setRelatorio] = useState<string | null>(null);
  const [relatorioCopiado, setRelatorioCopiado] = useState(false);

  const bills: BillView[] = data?.bills ?? [];
  const market = data?.market;
  const price = market ? (currency === 'BRL' ? market.btcBrl : market.btcUsd) : 0;
  const satsToFiat = (s: number) => (s / 1e8) * price;

  const lancados = bills.filter((b) => b.satsPaid > 0);
  const totalPago = lancados.reduce((a, b) => a + b.satsPaid, 0);

  const comparaveis = lancados.filter((b) => b.minedSats > 0);
  const pagoComparavel = comparaveis.reduce((a, b) => a + b.satsPaid, 0);
  const totalMinerado = comparaveis.reduce((a, b) => a + b.minedSats, 0);
  const mediaBurn = totalMinerado > 0 ? (pagoComparavel / totalMinerado) * 100 : null;
  const semProducao = lancados.length - comparaveis.length;

  /** Producao ja conhecida do mes escolhido, para orientar o preenchimento. */
  const previa = bills.find((b) => b.month === month);

  /** Mes em andamento, com o custo ja acumulado do contrato. */
  const emCurso = bills.find((b) => b.partial && b.estimate);
  const est = emCurso?.estimate ?? null;

  const dt: DowntimeReport | null = data?.downtime ?? null;
  const paradas = dt ? dt.miners.filter((m) => m.downHours > 0.01) : [];

  const billExtrato = bills.find((b) => b.month === extratoMes) ?? null;
  const textoExtrato =
    billExtrato && market
      ? montarExtrato(billExtrato, market, data?.contractedUsdMonth ?? 0, account || 'nao informada')
      : '';

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(textoExtrato);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      setCopiado(false);
    }
  };

  const limpar = () => {
    setSats('');
    setNote('');
    setPaidAt('');
    setMinedManual('');
    setFaturaUsd('');
    setAbatimentoUsd('');
    setAbatimentoMes('');
    setEditingFrom(null);
    setRecibo(null);
  };

  /**
   * Converte a fatura em dolar para satoshis pela cotacao do momento.
   * E acao explicita de proposito: o valor gravado precisa ser o que saiu de
   * fato, travado na cotacao do pagamento — converter sozinho ao salvar
   * inventaria um numero de um instante qualquer.
   */
  const converterFatura = () => {
    const usd = Number(String(faturaUsd).replace(',', '.'));
    if (!market || !Number.isFinite(usd) || usd <= 0) {
      setMsg('ERRO: informe o valor da fatura em dolar');
      setTimeout(() => setMsg(''), 4000);
      return;
    }
    setSats(String(Math.round((usd / market.btcUsd) * 1e8)));
  };

  const gerarRecibo = () => {
    const usd = Number(String(faturaUsd).replace(',', '.'));
    if (!market || !Number.isFinite(usd) || usd <= 0) {
      setMsg('ERRO: informe o valor da fatura em dolar');
      setTimeout(() => setMsg(''), 4000);
      return;
    }
    const doMes = bills.find((b) => b.month === month);
    // Usa o que esta no formulario, para o recibo refletir a tela mesmo antes
    // de gravar; sem nada digitado, cai no que ja esta lancado.
    const abatidoUsd = abatimentoUsd
      ? Number(String(abatimentoUsd).replace(',', '.'))
      : (doMes?.creditAppliedUsd ?? null);
    const abatidoMes = abatimentoMes || doMes?.creditAppliedMonth || null;

    setRecibo(
      montarRecibo(
        month,
        usd,
        market,
        { abatidoUsd, abatidoMes, medicao: doMes?.downtime ?? null },
        account || 'nao informada',
      ),
    );
  };

  const copiarRecibo = async () => {
    if (!recibo) return;
    try {
      await navigator.clipboard.writeText(recibo);
      setReciboCopiado(true);
      setTimeout(() => setReciboCopiado(false), 2500);
    } catch {
      setReciboCopiado(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/energy-bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month,
          sats: onlyDigits(sats),
          paidAt: paidAt ? new Date(`${paidAt}T12:00:00`).getTime() : null,
          note,
          minedManual: minedManual ? onlyDigits(minedManual) : null,
          invoiceUsd: faturaUsd ? Number(String(faturaUsd).replace(',', '.')) : null,
          creditAppliedUsd: abatimentoUsd ? Number(String(abatimentoUsd).replace(',', '.')) : null,
          creditAppliedMonth: abatimentoMes || null,
          renameFrom: editingFrom,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'falha ao gravar');
      await mutate(body, { revalidate: false });
      limpar();
      setMsg('LANCAMENTO GRAVADO');
    } catch (err) {
      setMsg(`ERRO: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const remove = async (m: string) => {
    if (!confirm(`Apagar o lancamento de ${mesLabel(m)}?`)) return;
    const res = await fetch(`/api/energy-bills?month=${m}`, { method: 'DELETE' });
    if (res.ok) await mutate(await res.json(), { revalidate: false });
  };

  const edit = (b: BillView) => {
    setMonth(b.month);
    setSats(String(b.satsPaid));
    setNote(b.note);
    setPaidAt(b.paidAt ? new Date(b.paidAt).toISOString().slice(0, 10) : '');
    setMinedManual(b.minedManual ? String(b.minedManual) : '');
    setFaturaUsd(b.invoiceUsd ? String(b.invoiceUsd) : '');
    setAbatimentoUsd(b.creditAppliedUsd ? String(b.creditAppliedUsd) : '');
    setAbatimentoMes(b.creditAppliedMonth ?? '');
    setEditingFrom(b.month);
    setRecibo(null);
  };

  return (
    <Panel
      title="Conta de energia paga em satoshis"
      right={lancados.length ? `${lancados.length} mes(es) lancado(s)` : 'nenhum lancamento'}
    >
      {lancados.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Total pago"
            value={`${fmtNum(totalPago)} sats`}
            sub={fmtMoney(satsToFiat(totalPago), currency, true)}
          />
          <Stat
            label="Minerado nos meses comparaveis"
            value={`${fmtNum(totalMinerado)} sats`}
            sub={
              semProducao > 0
                ? `${semProducao} mes(es) sem producao conhecida`
                : fmtMoney(satsToFiat(totalMinerado), currency, true)
            }
          />
          <Stat
            label="Sobrou"
            value={totalMinerado > 0 ? `${fmtNum(totalMinerado - pagoComparavel)} sats` : '—'}
            sub={
              totalMinerado > 0
                ? fmtMoney(satsToFiat(totalMinerado - pagoComparavel), currency, true)
                : 'sem producao para comparar'
            }
            tone={totalMinerado > 0 && totalMinerado - pagoComparavel < 0 ? 'crit' : 'normal'}
          />
          <Stat
            label="Producao consumida"
            value={mediaBurn !== null ? fmtPct(mediaBurn) : '—'}
            sub="da mineracao foi para a energia"
            tone={
              mediaBurn !== null && mediaBurn > 100 ? 'crit' : mediaBurn !== null && mediaBurn > 70 ? 'warn' : 'normal'
            }
          />
        </div>
      )}

      {/* ------------------------------------------------ mes em curso */}
      {emCurso && est && (
        <div className="mb-4 border border-phos/25 p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="panel-title">
              Energia consumida em {mesLabel(emCurso.month)} ate agora — para conferir com a cobranca
            </span>
            <span className="text-[0.62rem] dimmer">
              {est.elapsedDays.toFixed(1)} de {est.daysInMonth} dias ·{' '}
              {fmtPct((est.elapsedDays / est.daysInMonth) * 100, 0)} do mes
            </span>
          </div>

          <div className="mb-2">
            <Meter ratio={est.elapsedDays / est.daysInMonth} segments={31} height={8} />
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Acumulado (satoshis)"
              value={`≈ ${fmtNum(est.sats)}`}
              sub="convertido no preco de agora"
            />
            <Stat label="Acumulado em USD" value={fmtUsd(est.usd, true)} sub={`de ${fmtUsd(est.fullMonthUsd, true)} no mes`} />
            <Stat label="Acumulado em BRL" value={fmtMoney(est.brl, 'BRL', true)} sub="pelo cambio atual" />
            <Stat
              label="Projecao do mes fechado"
              value={`≈ ${fmtNum(est.fullMonthSats)} sats`}
              sub={`${fmtUsd(est.fullMonthUsd, true)} · ${fmtMoney((est.fullMonthUsd / est.usd) * est.brl, 'BRL', true)}`}
            />
          </div>

          {/* --------------------------------- desconto por indisponibilidade */}
          {dt && (
            <div className="mt-3 border-t border-phos/15 pt-2">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className="panel-title">Desconto proporcional por maquina parada</span>
                <span className="text-[0.6rem] dimmer">
                  competencia de {mesLabel(month.slice(0, 7))} ·{' '}
                  {dt.observedFrom
                    ? `observando desde ${new Date(dt.observedFrom).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                    : 'sem observacao'}{' '}
                  · {dt.coverageHours.toFixed(1)}h de {dt.hoursInMonth.toFixed(0)}h ({fmtPct(dt.coveragePct, 0)})
                </span>
              </div>

              {/* Maquina parada fora da queda geral: some no meio da tabela */}
              {dt.individualPeriods.length > 0 && (
                <div className="mb-3 border border-crit/50 p-2">
                  <span className="panel-title text-crit">
                    Paradas individuais ({dt.individualPeriods.length}) — fora das quedas gerais
                  </span>
                  <ul className="mt-1 space-y-0.5 text-[0.68rem]">
                    {dt.individualPeriods.map((p) => {
                      const emCursoAgora = p.to >= dt.until - 5 * 60_000;
                      return (
                        <li key={`${p.worker}-${p.from}`} className="flex flex-wrap gap-x-3">
                          <span className="hot">{p.label}</span>
                          <span className="dim">
                            {new Date(p.from).toLocaleString('pt-BR', {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                            {' → '}
                            {emCursoAgora
                              ? 'em curso'
                              : new Date(p.to).toLocaleTimeString('pt-BR', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                          </span>
                          <span className={emCursoAgora ? 'text-crit blink-crit' : 'text-warn'}>
                            {(p.soloMs / 3_600_000).toFixed(1)}h sozinha
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Quedas recuperadas da serie da pool, anteriores a nossa coleta */}
              {dt.importedPeriods.length > 0 && (
                <div className="mb-3 border border-warn/40 p-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="panel-title text-warn">
                      Quedas recuperadas do historico da pool ({dt.importedPeriods.length})
                    </span>
                    <span className="text-[0.6rem] dimmer">
                      antes do inicio da coleta · {dt.importedOutageHours.toFixed(2)}h
                    </span>
                  </div>
                  <ul className="mt-1 space-y-0.5 text-[0.68rem]">
                    {dt.importedPeriods.map((p) => (
                      <li key={p.from} className="flex flex-wrap gap-x-3">
                        <span className="hot">
                          {new Date(p.from).toLocaleString('pt-BR', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {' → '}
                          {new Date(p.to).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="dim">{Math.round(p.ms / 60000)} min de fazenda parada</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[0.6rem] dimmer">
                    Detectadas na serie de hashrate da conta, que alcanca 24h em passos de 10 min e 3 dias em passos
                    de 1 hora. Fora dessa janela a pool nao guarda o dado.
                  </p>
                </div>
              )}

              {paradas.length === 0 && dt.importedPeriods.length === 0 ? (
                <p className="text-[0.68rem] dim">
                  Nenhuma parada registrada na janela observada — sem desconto a reivindicar.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Stat
                      label="Parada por maquina"
                      value={`${dt.avgDownHours.toFixed(2)} h`}
                      sub={`media de ${dt.affected} afetada(s) · pior ${dt.worstDownHours.toFixed(2)} h`}
                      hint="Tempo de relogio que cada maquina ficou sem produzir"
                    />
                    <Stat
                      label="Horas-maquina paradas"
                      value={`${dt.totalDownHours.toFixed(2)}`}
                      sub="soma das 16 · base do rateio"
                      hint="Soma das horas paradas de todas as maquinas — nao e tempo de relogio"
                    />
                    <Stat
                      label="Credito devido"
                      value={`≈ ${fmtNum(dt.combinedCreditSats)} sats`}
                      sub={`${fmtUsd(dt.combinedCreditUsd)} · medido + recuperado`}
                      tone="warn"
                    />
                    <Stat
                      label="Queda total da fazenda"
                      value={`${dt.combinedOutageHours.toFixed(2)} h`}
                      sub={
                        dt.importedOutageHours > 0
                          ? `${dt.fullOutageHours.toFixed(2)}h medida + ${dt.importedOutageHours.toFixed(2)}h recuperada`
                          : 'todas as maquinas paradas juntas'
                      }
                      tone={dt.combinedOutageHours > 0 ? 'crit' : 'normal'}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="term-btn !py-[2px] !px-2 !text-[0.62rem]"
                      onClick={() => setVerDetalhe(!verDetalhe)}
                      aria-expanded={verDetalhe}
                    >
                      {verDetalhe ? '▼' : '▶'} detalhe por maquina ({paradas.length})
                    </button>
                    <button
                      className={`term-btn !py-[2px] !px-2 !text-[0.62rem] ${relatorio ? 'inverse' : ''}`}
                      onClick={() =>
                        relatorio
                          ? setRelatorio(null)
                          : setRelatorio(
                              montarRelatorioParadas(emCurso.month, dt, account || 'nao informada'),
                            )
                      }
                      title="Documento com eventos, detalhe por maquina e consolidado, para negociar o credito"
                    >
                      relatorio de paradas
                    </button>
                  </div>

                  <div className={`mt-2 overflow-x-auto ${verDetalhe ? '' : 'hidden'}`}>
                    <table className="term">
                      <thead>
                        <tr>
                          <th>Maquina</th>
                          <th>Horas paradas</th>
                          <th>% da janela</th>
                          <th>Contrato</th>
                          <th>Credito</th>
                          <th>Em satoshis</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paradas.map((m) => (
                          <tr key={m.worker}>
                            <td className="hot">{m.label}</td>
                            <td>{m.downHours.toFixed(2)} h</td>
                            <td>
                              <div className="flex items-center gap-2">
                                <span className={m.downPct > 5 ? 'text-warn' : ''}>{fmtPct(m.downPct, 1)}</span>
                                <div className="w-20">
                                  <Meter
                                    ratio={m.downPct / 100}
                                    segments={12}
                                    height={6}
                                    tone={m.downPct > 5 ? 'warn' : 'normal'}
                                  />
                                </div>
                              </div>
                            </td>
                            <td className="dim">{fmtUsd(m.monthlyUsd, true)}/mes</td>
                            <td className="text-warn">{fmtUsd(m.creditUsd)}</td>
                            <td className="text-warn">≈ {fmtNum(m.creditSats)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {relatorio && (
                    <div className="mt-3 border border-phos/40 p-2">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="panel-title">Relatorio de paradas — para negociar o credito</span>
                        <div className="flex items-center gap-2">
                          {relatorioCopiado && <span className="text-[0.65rem] hot">COPIADO</span>}
                          <button
                            className="term-btn !py-[2px] !px-3 !text-[0.62rem]"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(relatorio);
                                setRelatorioCopiado(true);
                                setTimeout(() => setRelatorioCopiado(false), 2500);
                              } catch {
                                setRelatorioCopiado(false);
                              }
                            }}
                          >
                            copiar texto
                          </button>
                          <button
                            className="term-btn !py-[2px] !px-3 !text-[0.62rem]"
                            onClick={() => setRelatorio(null)}
                          >
                            fechar
                          </button>
                        </div>
                      </div>
                      <pre className="doc overflow-x-auto p-3 text-[0.66rem] leading-[1.45] whitespace-pre">
                        {relatorio}
                      </pre>
                    </div>
                  )}

                  <p className="mt-2 text-[0.62rem] dimmer">
                    Maquina parada nao consome energia, entao as horas de queda viram credito sobre o contrato do mes.
                    Maquina apenas degradada nao entra: ela continua puxando quase toda a potencia. O desconto so cobre
                    o periodo que o coletor observou — quedas anteriores ao inicio da coleta nao aparecem aqui.
                  </p>
                </>
              )}
            </div>
          )}

          {emCurso.satsPaid > 0 && (
            <p className="mt-2 text-[0.66rem]">
              <span className="dim">Cobranca lancada: </span>
              <span className="hot">{fmtNum(emCurso.satsPaid)} sats</span>
              <span className="dim"> — diferenca de </span>
              <span className={Math.abs(emCurso.satsPaid - est.sats) / est.sats > 0.1 ? 'text-warn' : 'hot'}>
                {emCurso.satsPaid >= est.sats ? '+' : ''}
                {fmtNum(emCurso.satsPaid - est.sats)} sats (
                {(((emCurso.satsPaid - est.sats) / est.sats) * 100).toFixed(1)}%)
              </span>
              <span className="dim"> frente ao estimado.</span>
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------ formulario */}
      {/* Sete campos numa linha so estouravam a largura da tela; a grade agora
          quebra em duas faixas e as acoes ficam numa linha propria. */}
      <form onSubmit={submit} className="grid gap-3 border border-phos/20 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="panel-title">Mes de competencia</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required className="mt-1" />
        </label>
        <label className="block">
          <span className="panel-title">Fatura (US$)</span>
          <input
            type="text"
            inputMode="decimal"
            value={faturaUsd}
            onChange={(e) => setFaturaUsd(e.target.value)}
            placeholder="ex.: 1227.14"
            className="mt-1"
          />
        </label>
        <label className="block">
          <span className="panel-title">Pago (satoshis)</span>
          <div className="mt-1 flex gap-1">
            <input
              type="text"
              inputMode="numeric"
              value={sats}
              onChange={(e) => setSats(e.target.value)}
              placeholder="so quando pagar"
              className="min-w-0"
            />
            <button
              type="button"
              className="term-btn shrink-0 !px-2"
              onClick={converterFatura}
              title="Preenche com a fatura convertida pela cotacao de agora — use no momento do pagamento"
            >
              ≈
            </button>
          </div>
        </label>
        <label className="block">
          <span className="panel-title">Data do pagamento</span>
          <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="mt-1" />
        </label>
        <label className="block">
          <span className="panel-title">Minerado (sats)</span>
          <input
            type="text"
            inputMode="numeric"
            value={minedManual}
            onChange={(e) => setMinedManual(e.target.value)}
            placeholder={previa && previa.minedSats > 0 ? fmtNum(previa.minedSats) : 'opcional'}
            className="mt-1"
          />
        </label>
        <label className="block">
          <span className="panel-title">Abatido nesta fatura</span>
          <div className="mt-1 flex gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={abatimentoUsd}
              onChange={(e) => setAbatimentoUsd(e.target.value)}
              placeholder="US$"
              className="min-w-0"
              title="Credito de paradas que o cobrador ja descontou nesta fatura"
            />
            <input
              type="month"
              value={abatimentoMes}
              onChange={(e) => setAbatimentoMes(e.target.value)}
              className="min-w-0 !text-[0.68rem]"
              title="De qual competencia veio esse credito"
            />
          </div>
        </label>
        <label className="block">
          <span className="panel-title">Observacao</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="opcional" className="mt-1" />
        </label>
        <div className="flex flex-wrap items-center gap-2 border-t border-phos/15 pt-3 sm:col-span-2 lg:col-span-4">
          <button type="submit" className="term-btn" disabled={busy}>
            {busy ? 'gravando…' : editingFrom ? 'salvar' : 'lancar'}
          </button>
          <button
            type="button"
            className={`term-btn ${recibo ? 'inverse' : ''}`}
            onClick={() => (recibo ? setRecibo(null) : gerarRecibo())}
            title="Gera o pedido de invoice Lightning para enviar ao cobrador"
          >
            recibo
          </button>
          {editingFrom && (
            <button type="button" className="term-btn" onClick={limpar}>
              cancelar
            </button>
          )}
          <span className="ml-auto text-[0.62rem] dimmer">
            Pago e Data do pagamento so quando o dinheiro sair — o botao ≈ converte a fatura na hora.
          </span>
        </div>
      </form>

      {/* ------------------------------------------------ recibo */}
      {recibo && market && (
        <div className="mt-3 border border-phos/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="panel-title">Pedido de invoice — para mandar no WhatsApp</span>
            <div className="flex items-center gap-2">
              {reciboCopiado && <span className="text-[0.65rem] hot">COPIADO</span>}
              <button className="term-btn !py-[2px] !px-3 !text-[0.62rem]" onClick={copiarRecibo}>
                copiar texto
              </button>
              <button className="term-btn !py-[2px] !px-3 !text-[0.62rem]" onClick={gerarRecibo}>
                atualizar cotacao
              </button>
              <button className="term-btn !py-[2px] !px-3 !text-[0.62rem]" onClick={() => setRecibo(null)}>
                fechar
              </button>
            </div>
          </div>

          <pre className="doc overflow-x-auto p-3 text-[0.7rem] leading-[1.5] whitespace-pre">{recibo}</pre>

          <p className="mt-2 text-[0.6rem] dimmer">
            A cotacao usada e a do momento em que o recibo foi gerado. Se demorar para enviar, use
            <span className="dim"> atualizar cotacao</span> antes de mandar — a quantidade de satoshis muda com o
            preco do bitcoin.
          </p>
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.62rem] dimmer">
        {editingFrom && (
          <span className="text-warn">
            editando {mesLabel(editingFrom)}
            {editingFrom !== month && ` — sera movido para ${mesLabel(month)}`}
          </span>
        )}
        {previa && previa.minedSats > 0 && (
          <span>
            producao de {mesLabel(month)}: {fmtNum(previa.minedSats)} sats ({FONTE[previa.minedSource].hint})
          </span>
        )}
        {onlyDigits(sats) > 0 && price > 0 && (
          <span className="hot">
            {fmtNum(onlyDigits(sats))} sats = {fmtMoney(satsToFiat(onlyDigits(sats)), currency)} hoje
          </span>
        )}
        {data && data.contractedUsdMonth > 0 && (
          <span>
            contrato: {fmtUsd(data.contractedUsdMonth, true)}/mes ≈ {fmtNum(data.contractedSatsAtCurrentPrice)} sats
            no preco atual
          </span>
        )}
        {msg && <span className={msg.startsWith('ERRO') ? 'text-crit' : 'hot'}>{msg}</span>}
      </div>

      {/* ------------------------------------------------ historico */}
      <div className="mt-3 overflow-x-auto">
        <table className="term">
          <thead>
            <tr>
              <th>Mes</th>
              <th>Pago (sats)</th>
              <th>Credito por parada</th>
              <th>Minerado (sats)</th>
              <th>Fonte</th>
              <th>Sobra</th>
              <th>Consumo da producao</th>
              <th>Pago em {currency}</th>
              <th>Quando</th>
              <th>Obs.</th>
              <th className="acoes">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={11} className="dim">
                  carregando…
                </td>
              </tr>
            )}
            {!isLoading && bills.length === 0 && (
              <tr>
                <td colSpan={11} className="dim">
                  Nenhum mes registrado ainda. Lance o valor pago acima.
                </td>
              </tr>
            )}
            {bills.map((b) => {
              // No mes em curso, quando ainda nao ha fatura lancada, usamos o
              // custo acumulado estimado para preencher sobra e consumo.
              // Tres estados: pago (sats travados), faturado (dolar firme, sats
              // flutuando) e estimado (so o contrato).
              const est = b.estimate;
              const pago = b.costSource === 'pago';
              const faturado = b.costSource === 'faturado';
              const usandoEstimativa = !pago && b.costSats > 0;
              const custoSats = b.costSats;
              const sobra = b.minedSats > 0 && custoSats > 0 ? b.minedSats - custoSats : null;
              const consumo = b.minedSats > 0 && custoSats > 0 ? (custoSats / b.minedSats) * 100 : null;
              const dif = b.satsPaid > 0 && b.estimate ? ((b.satsPaid - b.estimate.sats) / b.estimate.sats) * 100 : null;
              // Cada competencia tem o seu proprio credito por indisponibilidade.
              const credito = b.downtime;

              return (
              <tr key={b.month}>
                <td className="hot">
                  {mesLabel(b.month)}
                  {b.partial && <span className="dimmer ml-1 text-[0.6rem]">em curso</span>}
                </td>
                <td className={pago ? 'hot' : usandoEstimativa ? 'dim' : 'dimmer'}>
                  {pago ? (
                    <>
                      {fmtNum(b.satsPaid)}
                      {b.invoiceUsd !== null && (
                        <div className="text-[0.6rem] dimmer">fatura US$ {b.invoiceUsd.toFixed(2)}</div>
                      )}
                      {b.invoiceUsd === null && dif !== null && (
                        <div className={`text-[0.6rem] ${Math.abs(dif) > 10 ? 'text-warn' : 'dimmer'}`}>
                          est. {fmtNum(est!.sats)} ({dif >= 0 ? '+' : ''}
                          {dif.toFixed(0)}%)
                        </div>
                      )}
                    </>
                  ) : usandoEstimativa ? (
                    <span
                      title={
                        faturado
                          ? `Fatura de US$ ${b.invoiceUsd?.toFixed(2)} convertida pela cotacao de agora — muda ate o pagamento`
                          : `${est!.elapsedDays.toFixed(1)} de ${est!.daysInMonth} dias · US$ ${est!.usd.toFixed(2)} de ${est!.fullMonthUsd}`
                      }
                    >
                      ≈ {fmtNum(custoSats)}
                      <div className={`text-[0.6rem] ${faturado ? 'text-warn' : 'dimmer'}`}>
                        {faturado ? `a pagar · US$ ${b.invoiceUsd?.toFixed(2)}` : 'estimado'}
                      </div>
                    </span>
                  ) : (
                    '— nao lancado'
                  )}
                </td>
                <td>
                  {b.creditEarnedSats > 0 || b.creditGrantedSats > 0 || b.creditAppliedSats > 0 ? (
                    <div className="space-y-0.5">
                      {/* O que medimos: referencia para conferir a fatura. */}
                      {b.creditEarnedSats > 0 && (
                        <div
                          className="dim"
                          title={
                            credito
                              ? `${credito.combinedOutageHours.toFixed(2)}h de fazenda parada medidas nesta competencia`
                              : ''
                          }
                        >
                          medimos {fmtNum(b.creditEarnedSats)}
                          <span className="ml-1 text-[0.6rem] dimmer">referencia</span>
                        </div>
                      )}
                      {/* O que ele concedeu: e isto que entra na conta. */}
                      {b.creditGrantedSats > 0 ? (
                        <div className="text-warn">
                          concedeu {fmtNum(b.creditGrantedSats)}
                          {b.creditEarnedSats > 0 && (
                            <span className="ml-1 text-[0.6rem] dimmer">
                              {b.creditGrantedSats >= b.creditEarnedSats ? '≥' : '<'} medido
                            </span>
                          )}
                        </div>
                      ) : (
                        b.creditEarnedSats > 0 && (
                          <div className="text-[0.6rem] dimmer">aguardando abatimento</div>
                        )
                      )}
                      {b.creditAppliedSats > 0 && (
                        <div className="hot text-[0.66rem]">
                          − {fmtNum(b.creditAppliedSats)}
                          <span className="ml-1 dimmer">
                            de {b.creditAppliedMonth ? mesLabel(b.creditAppliedMonth) : 'outra comp.'}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="dimmer">—</span>
                  )}
                </td>
                <td className={b.minedSats > 0 ? '' : 'dimmer'}>
                  {b.minedSats > 0 ? fmtNum(b.minedSats) : 'sem dado'}
                </td>
                <td className="dim text-[0.68rem]" title={FONTE[b.minedSource].hint}>
                  {FONTE[b.minedSource].label}
                  {b.minedSource === 'pagamentos' && (
                    <span className="dimmer"> ({b.paymentsCount})</span>
                  )}
                </td>
                <td className={sobra !== null && sobra < 0 ? 'text-crit' : usandoEstimativa ? 'dim' : ''}>
                  {sobra !== null ? `${usandoEstimativa ? '≈ ' : ''}${fmtNum(sobra)}` : '—'}
                </td>
                <td>
                  {consumo !== null ? (
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          consumo > 100
                            ? 'text-crit'
                            : consumo > 70
                              ? 'text-warn'
                              : usandoEstimativa
                                ? 'dim'
                                : 'hot'
                        }
                      >
                        {usandoEstimativa && '≈ '}
                        {fmtPct(consumo, 1)}
                      </span>
                      <div className="w-24">
                        <Meter
                          ratio={consumo / 100}
                          segments={12}
                          height={6}
                          tone={consumo > 100 ? 'crit' : consumo > 70 ? 'warn' : 'normal'}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="dimmer">—</span>
                  )}
                </td>
                <td className={usandoEstimativa ? 'dim' : ''}>
                  {b.satsPaid > 0
                    ? fmtMoney(satsToFiat(b.satsPaid), currency, true)
                    : usandoEstimativa
                      ? `≈ ${fmtMoney(currency === 'BRL' ? est!.brl : est!.usd, currency, true)}`
                      : '—'}
                </td>
                <td className="dim">
                  {b.paidAt
                    ? fmtDate(b.paidAt)
                    : usandoEstimativa
                      ? b.partial
                        ? `${est!.elapsedDays.toFixed(1)}/${est!.daysInMonth} dias`
                        : 'mes fechado · a lancar'
                      : '—'}
                </td>
                <td className="dim whitespace-normal">
                  {b.note ||
                    (faturado
                      ? 'faturado, aguardando pagamento'
                      : usandoEstimativa
                        ? b.partial
                          ? 'custo acumulado do contrato'
                          : 'contrato cheio · fatura ainda nao lancada'
                        : '—')}
                </td>
                <td className="acoes">
                  <div className="flex gap-1">
                    <button
                      className={`term-btn !py-[1px] !px-2 !text-[0.6rem] ${extratoMes === b.month ? 'inverse' : ''}`}
                      onClick={() => setExtratoMes(extratoMes === b.month ? null : b.month)}
                    >
                      extrato
                    </button>
                    <button className="term-btn !py-[1px] !px-2 !text-[0.6rem]" onClick={() => edit(b)}>
                      editar
                    </button>
                    {b.hasRecord && (
                      <button className="term-btn !py-[1px] !px-2 !text-[0.6rem]" onClick={() => remove(b.month)}>
                        apagar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------ extrato */}
      {billExtrato && textoExtrato && (
        <div className="mt-4 border border-phos/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="panel-title">
              Extrato de {mesLabel(billExtrato.month)} — para enviar ao cobrador
            </span>
            <div className="flex items-center gap-2">
              {copiado && <span className="text-[0.65rem] hot">COPIADO</span>}
              <button className="term-btn !py-[2px] !px-3 !text-[0.62rem]" onClick={copiar}>
                copiar texto
              </button>
              <button
                className="term-btn !py-[2px] !px-3 !text-[0.62rem]"
                onClick={() => setExtratoMes(null)}
              >
                fechar
              </button>
            </div>
          </div>

          <pre className="doc overflow-x-auto p-3 text-[0.68rem] leading-[1.45] whitespace-pre">
            {textoExtrato}
          </pre>

          <p className="mt-2 text-[0.6rem] dimmer">
            O mesmo texto que aparece aqui e o que vai para a area de transferencia — tire um print ou cole no
            WhatsApp, no e-mail ou num documento. Sem acentos e sem caracteres especiais, para nao quebrar em
            nenhum aplicativo.
          </p>
        </div>
      )}

      <div className="mt-3 space-y-1 border-t border-phos/15 pt-2 text-[0.62rem] dimmer">
        <p>
          O credito que <span className="dim">medimos</span> e apenas referencia para conferir a fatura — quem altera
          o custo da competencia e o que o cobrador de fato concedeu, informado no campo Abatido nesta fatura.
        </p>
        <p>
          O botao <span className="dim">extrato</span>, na coluna Acoes de cada mes, monta um documento pronto para
          fotografar ou copiar e enviar ao cobrador.
        </p>
        <p>
          <span className="dim">Competencia</span> e o mes em que a energia foi consumida, nao o mes em que a fatura
          foi paga — use a data do pagamento para registrar isso.
        </p>
        <p>
          A producao vem do <span className="dim">historico diario</span> da pool, que so guarda cerca de 30 dias.
          Para meses mais antigos usamos a soma dos <span className="dim">pagamentos</span> recebidos naquele mes.
          Se nenhuma das duas cobrir, preencha o campo Minerado a mao.
        </p>
        <p>
          Os valores com <span className="dim">≈</span> sao estimativa: o contrato configurado rateado pelos dias ja
          decorridos do mes. O valor em satoshis usa o preco do BTC de agora — como o contrato e fechado em dolar, a
          quantidade final de satoshis so fica definida no momento do pagamento.
        </p>
        {mediaBurn !== null && (
          <p>
            No acumulado comparavel, cada satoshi minerado deixou{' '}
            <span className="hot">{fmtNum(100 - mediaBurn, 1)}%</span> depois de pagar a energia.
          </p>
        )}
      </div>
    </Panel>
  );
}
