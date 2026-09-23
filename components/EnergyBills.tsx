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
  lowFleet: LowFleet;
}

/** Fazenda produzindo abaixo da faixa: perda de entrega, nao de energia. */
interface LowFleet {
  thresholdPct: number;
  hours: number;
  lostEquivHours: number;
  suggestedUsd: number;
  suggestedBrl: number;
  suggestedSats: number;
  events: { from: number; to: number; belowMs: number; minPct: number }[];
  byWorker: { worker: string; label: string; lostEquivHours: number; usd: number }[];
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

/**
 * Copia texto para a area de transferencia.
 *
 * `navigator.clipboard` so existe em contexto seguro — HTTPS ou localhost.
 * Este painel roda em HTTP numa rede privada, entao ali ele e `undefined` e
 * o botao falhava em silencio. O caminho antigo, com textarea fora da tela e
 * `execCommand`, e feio mas funciona em contexto inseguro, que e justamente
 * onde o outro nao funciona.
 */
async function copiarTexto(texto: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {
    // cai no plano B
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, texto.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const hm = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Extrato da fatura de uma competencia, em texto puro.
 *
 * A energia e cobrada adiantada e o desconto das paradas so cai na
 * competencia seguinte. Entao a fatura de setembro e o contrato de setembro
 * menos o que parou em agosto — e e isso que este documento mostra, com o mes
 * anterior ja fechado. E a foto final da previa enviada antes de o mes
 * comecar, nos mesmos termos e na mesma ordem, para o host conferir uma
 * contra a outra sem precisar traduzir nada.
 *
 * Evita acentos e caracteres de desenho para nao quebrar em aplicativos de
 * mensagem.
 */
function montarExtrato(
  bill: BillView,
  anterior: BillView | null,
  market: { btcUsd: number; btcBrl: number; usdBrl: number },
  contratoUsd: number,
  conta: string,
): string {
  const L: string[] = [];
  const regua = '='.repeat(56);
  const traco = '  ' + '-'.repeat(52);
  const mes = mesLabel(bill.month);
  const dt = bill.downtime;
  /** O que sustenta o desconto desta fatura: a medicao do mes anterior. */
  const base = anterior?.downtime ?? null;
  const mesBase = anterior ? mesLabel(anterior.month) : null;

  // Contrato da competencia, na melhor fonte disponivel: o que o host
  // faturou, senao a projecao do mes, senao o contrato vigente.
  const contratoMes = bill.invoiceUsd ?? bill.estimate?.fullMonthUsd ?? contratoUsd;
  /**
   * Satoshis de um valor em dolar, na cotacao deste instante.
   *
   * Os campos em sats que vem da API foram convertidos quando o payload foi
   * montado; um documento emitido meia hora depois mostraria numeros de duas
   * cotacoes diferentes. Tudo aqui e derivado na hora, e o documento diz qual
   * cotacao usou.
   */
  const sats = (usd: number) => (market.btcUsd > 0 ? Math.round((usd / market.btcUsd) * 1e8) : 0);
  const emSats = (usd: number) => `${sats(usd).toLocaleString('pt-BR')} sats`;
  const creditoUsd = base?.combinedCreditUsd ?? 0;
  const aPagarUsd = Math.max(0, contratoMes - creditoUsd);

  L.push(regua);
  L.push(' EXTRATO DE ENERGIA - MINER-WATCH');
  L.push(` Competencia: ${mes}${bill.partial ? '  (mes em curso)' : ''}`);
  L.push(` Conta na pool: ${conta}`);
  L.push(` Emitido em: ${dm(Date.now())}`);
  L.push(regua);
  L.push('');

  L.push('CONTRATO DE ENERGIA');
  L.push(linha('Competencia', mes));
  L.push(linha('Valor do mes', `US$ ${contratoMes.toFixed(2)}`));
  if (dt) {
    L.push(linha('Maquinas', String(dt.miners.length)));
    const cortesia = dt.miners.filter((m) => m.monthlyUsd <= 0);
    if (cortesia.length > 0) {
      L.push(linha('Em cortesia', `${cortesia.length} maquina(s), sem custo`));
      L.push(`  ${cortesia.map((m) => m.label).join(', ')}`);
    }
  }
  L.push('');

  // ---------------------------------------------- desconto do mes anterior
  if (base && mesBase) {
    L.push(`CREDITO DE INDISPONIBILIDADE - ${mesBase.toUpperCase()}`);
    L.push(linha('Periodo apurado', `${dm(base.since)} a ${dm(base.until)}`));
    L.push(linha('Medicao propria desde', base.observedFrom ? dm(base.observedFrom) : 'sem medicao'));
    L.push(linha('Cobertura', `${base.coverageHours.toFixed(1)}h de ${base.hoursInMonth.toFixed(0)}h`));
    L.push('');

    const eventos = [
      ...base.importedPeriods.map((x) => ({ ...x, fonte: 'historico da pool' })),
      ...base.measuredPeriods.map((x) => ({ ...x, fonte: 'medido pelo coletor' })),
    ].sort((a, b) => a.from - b.from);

    L.push(`  Quedas totais da fazenda (${eventos.length}):`);
    if (eventos.length === 0) {
      L.push('    Nenhuma registrada no periodo.');
    } else {
      for (const e of eventos) {
        L.push(
          `    ${dm(e.from)} -> ${hm(e.to)}   ${String(Math.round(e.ms / 60000)).padStart(4)} min   ${e.fonte}`,
        );
      }
    }

    if (base.individualPeriods.length > 0) {
      L.push('');
      L.push(`  Maquinas paradas fora das quedas gerais (${base.individualPeriods.length}):`);
      for (const x of base.individualPeriods) {
        L.push(
          `    ${x.label.padEnd(12)} ${dm(x.from)} -> ${hm(x.to)}  ` +
            `${(x.soloMs / 3_600_000).toFixed(1).padStart(5)} h sozinha`,
        );
      }
    }

    const paradas = base.miners.filter((m) => m.downHours > 0.01);
    if (paradas.length > 0) {
      L.push('');
      L.push('  Detalhe por maquina:');
      L.push('    maquina        horas    contrato    credito');
      for (const m of paradas) {
        L.push(
          `    ${m.label.padEnd(13)} ${m.downHours.toFixed(2).padStart(6)}   ` +
            `US$ ${String(m.monthlyUsd).padStart(4)}   US$ ${m.creditUsd.toFixed(3).padStart(7)}`,
        );
      }
    }

    // Duas contagens diferentes, e confundi-las e o caminho mais curto para o
    // host achar que o credito esta inflado: a queda geral e tempo de relogio,
    // enquanto o credito se apura maquina a maquina — uma parada sozinha nao
    // mexe na primeira e mexe na segunda.
    const horasMaquina = base.totalDownHours;
    const horasCobraveis = base.miners
      .filter((m) => m.monthlyUsd > 0)
      .reduce((a, m) => a + m.downHours, 0);

    L.push(traco);
    L.push(linha('Fazenda parada (relogio)', `${base.combinedOutageHours.toFixed(2)} h`));
    L.push(linha('Horas-maquina paradas', `${horasMaquina.toFixed(2)} h`));
    if (horasCobraveis < horasMaquina - 0.005) {
      L.push(linha('  das quais cobraveis', `${horasCobraveis.toFixed(2)} h`));
    }
    L.push(linha('Credito apurado', `US$ ${creditoUsd.toFixed(2)}`));
    L.push(linha('Em satoshis', emSats(creditoUsd)));
    L.push('  Base: horas paradas de cada maquina x o custo por hora dela.');
    if (horasCobraveis < horasMaquina - 0.005) {
      L.push('  Maquina em cortesia nao gera credito: nada a abater.');
    }
    L.push('');
  } else {
    L.push('CREDITO DE INDISPONIBILIDADE');
    L.push(
      mesBase
        ? `  Sem medicao para ${mesBase}: o coletor nao estava em operacao.`
        : '  Sem competencia anterior medida.',
    );
    L.push('');
  }

  // ------------------------------------------------------------- a pagar
  L.push(traco);
  L.push(linha(`CONTRATO DE ${mes.toUpperCase()}`, `US$ ${contratoMes.toFixed(2)}`));
  if (creditoUsd > 0) L.push(linha(`(-) credito de ${mesBase}`, `US$ ${creditoUsd.toFixed(2)}`));
  L.push(linha('A PAGAR', `US$ ${aPagarUsd.toFixed(2)}`));
  L.push(linha('Em real', `R$ ${(aPagarUsd * market.usdBrl).toFixed(2)}`));
  L.push(linha('Em satoshis', emSats(aPagarUsd)));
  L.push(linha('Cotacao usada', `BTC = US$ ${Math.round(market.btcUsd).toLocaleString('pt-BR')}`));
  L.push('');

  // ---------------------------------------------------------- liquidacao
  if (bill.hasRecord || bill.satsPaid > 0 || bill.creditGrantedUsd > 0) {
    L.push('LIQUIDACAO');
    if (bill.invoiceUsd !== null) L.push(linha('Faturado pelo host', `US$ ${bill.invoiceUsd.toFixed(2)}`));
    if (bill.creditGrantedUsd > 0) {
      L.push(linha('Credito concedido', `US$ ${bill.creditGrantedUsd.toFixed(2)}`));
      const dif = bill.creditGrantedUsd - creditoUsd;
      if (Math.abs(dif) > 0.005) {
        L.push(linha('Diferenca do medido', `US$ ${dif.toFixed(2)} ${dif > 0 ? 'a mais' : 'a menos'}`));
      }
    }
    if (bill.satsPaid > 0) {
      L.push(linha('Pago', `${bill.satsPaid.toLocaleString('pt-BR')} sats`));
      if (bill.paidAt) L.push(linha('Pago em', dm(bill.paidAt)));
    }
    if (bill.note) L.push(linha('Observacao', bill.note));
    L.push('');
  }

  // ------------------------------------- desempenho, sempre em separado
  const lf = base?.lowFleet;
  if (lf && lf.hours > 0.05 && mesBase) {
    L.push(regua);
    L.push(' ADICIONAL PARA NEGOCIACAO - DESEMPENHO DA FAZENDA');
    L.push(regua);
    L.push('');
    L.push(`  Tempo com a fazenda inteira produzindo abaixo de ${lf.thresholdPct}%`);
    L.push(`  do hashrate nominal contratado, em ${mesBase}:`);
    L.push('');
    L.push(linha('Tempo abaixo da faixa', `${lf.hours.toFixed(2)} h`));
    L.push(linha('Producao nao entregue', `${lf.lostEquivHours.toFixed(2)} h-maquina`));
    L.push(linha('Equivalente em dolar', `US$ ${lf.suggestedUsd.toFixed(2)}`));
    L.push(linha('Em real', `R$ ${(lf.suggestedUsd * market.usdBrl).toFixed(2)}`));
    L.push(linha('Em satoshis', emSats(lf.suggestedUsd)));

    if (lf.events.length > 0) {
      L.push('');
      L.push(`  Episodios (${lf.events.length}):`);
      for (const e of lf.events.slice(-12)) {
        L.push(
          `    ${dm(e.from)} -> ${hm(e.to)}  ${String(Math.round(e.belowMs / 60000)).padStart(4)} min abaixo, ` +
            `minimo ${e.minPct.toFixed(0)}%`,
        );
      }
      if (lf.events.length > 12) L.push(`    (mostrando os 12 mais recentes de ${lf.events.length})`);
    }

    if (lf.byWorker.length > 0) {
      L.push('');
      L.push('  Por maquina, o que deixou de ser entregue:');
      L.push('    maquina        h-maquina    equivalente');
      for (const w of lf.byWorker.slice(0, 12)) {
        L.push(
          `    ${w.label.padEnd(13)} ${w.lostEquivHours.toFixed(2).padStart(7)}    US$ ${w.usd.toFixed(2).padStart(7)}`,
        );
      }
    }

    L.push('');
    const liquido = Math.max(0, aPagarUsd - lf.suggestedUsd);
    L.push(linha('A pagar se aceito', `US$ ${liquido.toFixed(2)}`));
    L.push(linha('Em real', `R$ ${(liquido * market.usdBrl).toFixed(2)}`));
    L.push(linha('Em satoshis', emSats(liquido)));
    L.push('');
    L.push('  Este item nao esta somado ao total acima.');
    L.push('  A maquina degradada consumiu a energia quase toda, entao isto');
    L.push('  nao e devolucao de consumo como no caso da parada: e a parte');
    L.push('  do servico contratado que nao foi entregue. Fica registrado');
    L.push('  com data e medicao para conversarmos com numero, e nao com');
    L.push('  impressao.');
    L.push('');
    L.push('  As janelas de queda total estao fora desta conta: aquelas horas');
    L.push('  ja entram no credito acima, e maquina parada nao conta como');
    L.push('  entrega parcial. Nada aqui e cobrado duas vezes.');
    L.push('');
  }

  // O que esta correndo nesta competencia nao entra aqui: e assunto da
  // previa do mes seguinte, que ja o apresenta como desconto.

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

interface PreviaFaixa {
  quantidade: number;
  cheioUsd: number;
  totalUsd: number;
  cobravelDesde: number | null;
  courtesyDays: number;
}

interface Previa {
  month: string;
  contractUsd: number;
  faixas: PreviaFaixa[];
  creditFrom: string;
  creditUsd: number;
  creditSats: number;
  outageHours: number;
  creditPartial: boolean;
  netUsd: number;
  netSats: number;
  lowFleetHours: number;
  lowFleetPct: number;
  lowFleetUsd: number;
  lowFleetSats: number;
  netComDesempenhoUsd: number;
  netComDesempenhoSats: number;
}

/**
 * Previa da cobranca do mes seguinte, para mandar ao host antes de ele emitir.
 * Com cobranca adiantada, esperar a fatura chegar significa receber sem o
 * credito das paradas — que so e abatido na competencia seguinte.
 */
function montarPrevia(
  p: Previa,
  dt: DowntimeReport | null,
  market: { btcUsd: number; usdBrl: number },
  conta: string,
): string {
  const L: string[] = [];
  const regua = '='.repeat(58);
  const traco = '  ' + '-'.repeat(54);
  const dia = (t: number) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const hhmm = (t: number) =>
    new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  /** Sats na cotacao deste instante, nao na de quando o payload foi montado. */
  const emSats = (usd: number) =>
    `${(market.btcUsd > 0 ? Math.round((usd / market.btcUsd) * 1e8) : 0).toLocaleString('pt-BR')} sats`;

  L.push(regua);
  L.push(' PREVIA DE COBRANCA - ENERGIA');
  L.push(` Competencia: ${mesLabel(p.month)}`);
  L.push(` Conta na pool: ${conta}`);
  L.push(` Emitido em: ${dm(Date.now())}`);
  L.push(regua);
  L.push('');

  L.push('CONTRATO');
  for (const f of p.faixas) {
    const desc =
      f.cobravelDesde === null
        ? `${String(f.quantidade).padStart(2)} maquina(s), mes integral`
        : `${String(f.quantidade).padStart(2)} maquina(s), a partir de ${dia(f.cobravelDesde)}`;
    L.push(`  ${desc.padEnd(38)} US$ ${f.totalUsd.toFixed(2).padStart(8)}`);
    if (f.cobravelDesde !== null) {
      L.push(`      cortesia de ${f.courtesyDays} dias encerra em ${dia(f.cobravelDesde)}`);
    }
  }
  L.push(traco);
  L.push(linha('Subtotal', `US$ ${p.contractUsd.toFixed(2)}`, 28));
  L.push('');

  L.push(`CREDITO DE INDISPONIBILIDADE - ${mesLabel(p.creditFrom).toUpperCase()}`);
  const horasMaquina = dt ? dt.miners.reduce((a, m) => a + m.downHours, 0) : 0;
  const horasCobraveis = dt
    ? dt.miners.filter((m) => m.monthlyUsd > 0).reduce((a, m) => a + m.downHours, 0)
    : 0;
  const eventos = dt
    ? [...dt.importedPeriods, ...dt.measuredPeriods].sort((a, b) => a.from - b.from)
    : [];
  if (eventos.length === 0) {
    L.push('  Nenhuma queda registrada ate agora.');
  } else {
    L.push('  Quedas totais da fazenda:');
    for (const e of eventos) {
      L.push(
        `    ${hhmm(e.from)} -> ${new Date(e.to).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` +
          `  ${String(Math.round(e.ms / 60000)).padStart(4)} min`,
      );
    }
    if (dt && dt.individualPeriods.length > 0) {
      L.push('  Maquinas paradas fora das quedas gerais:');
      for (const m of dt.individualPeriods) {
        L.push(`    ${m.label.padEnd(12)} ${(m.soloMs / 3_600_000).toFixed(1).padStart(5)} h sozinha`);
      }
    }
    L.push(traco);
    // Duas contagens diferentes, e confundi-las e o caminho mais curto para o
    // host achar que o credito esta inflado: a queda geral e tempo de relogio,
    // enquanto o credito se apura maquina a maquina — uma parada sozinha nao
    // mexe na primeira e mexe na segunda.
    L.push(linha('Fazenda parada (relogio)', `${p.outageHours.toFixed(2)} h`, 28));
    L.push(linha('Horas-maquina paradas', `${horasMaquina.toFixed(2)} h`, 28));
    if (horasCobraveis < horasMaquina - 0.005) {
      L.push(linha('  das quais cobraveis', `${horasCobraveis.toFixed(2)} h`, 28));
    }
  }
  L.push(linha('Credito apurado', `US$ ${p.creditUsd.toFixed(2)}`, 28));
  L.push(linha('Em satoshis', emSats(p.creditUsd), 28));
  L.push('  Base: horas paradas de cada maquina x o custo por hora dela.');
  if (horasCobraveis < horasMaquina - 0.005) {
    L.push('  Maquina em cortesia nao gera credito: nada a abater.');
  }
  if (p.creditPartial) {
    L.push('');
    L.push(`  Apurado ate ${dm(Date.now())}. ${mesLabel(p.creditFrom)} ainda esta`);
    L.push('  em curso, entao o valor final pode aumentar.');
  }
  L.push('');

  L.push(traco);
  L.push(linha('A PAGAR', `US$ ${p.netUsd.toFixed(2)}`, 28));
  L.push(linha('Em real', `R$ ${(p.netUsd * market.usdBrl).toFixed(2)}`, 28));
  L.push(linha('Em satoshis', emSats(p.netUsd), 28));
  L.push(linha('Cotacao usada', `BTC = US$ ${Math.round(market.btcUsd).toLocaleString('pt-BR')}`, 28));
  L.push('');
  L.push('  Favor emitir a cobranca ja considerando o credito acima.');
  L.push('  O valor em satoshis vale para a cotacao do momento; na hora');
  L.push('  do pagamento eu refaco a conversao.');

  // Vem depois do total de proposito: e proposta, nao apuracao. O credito de
  // parada se defende sozinho com a medicao; misturar os dois no mesmo
  // subtotal daria ao host um motivo para contestar o conjunto.
  if (p.lowFleetHours > 0.05 && dt) {
    L.push('');
    L.push(regua);
    L.push(' ADICIONAL PARA NEGOCIACAO - DESEMPENHO DA FAZENDA');
    L.push(regua);
    L.push('');
    L.push(`  Tempo com a fazenda inteira produzindo abaixo de ${p.lowFleetPct}%`);
    L.push(`  do hashrate nominal contratado, em ${mesLabel(p.creditFrom)}:`);
    L.push('');
    L.push(linha('Tempo abaixo da faixa', `${p.lowFleetHours.toFixed(2)} h`, 28));
    L.push(
      linha('Producao nao entregue', `${dt.lowFleet.lostEquivHours.toFixed(2)} h-maquina`, 28),
    );
    L.push(linha('Equivalente em dolar', `US$ ${p.lowFleetUsd.toFixed(2)}`, 28));
    if (market.usdBrl > 0) {
      L.push(linha('Em real', `R$ ${(p.lowFleetUsd * market.usdBrl).toFixed(2)}`, 28));
    }
    L.push(linha('Em satoshis', emSats(p.lowFleetUsd), 28));

    if (dt.lowFleet.events.length > 0) {
      L.push('');
      L.push(`  Episodios (${dt.lowFleet.events.length}):`);
      for (const e of dt.lowFleet.events.slice(-12)) {
        L.push(
          `    ${hhmm(e.from)} -> ${new Date(e.to).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` +
            `  ${String(Math.round(e.belowMs / 60000)).padStart(4)} min abaixo, minimo ${e.minPct.toFixed(0)}%`,
        );
      }
      if (dt.lowFleet.events.length > 12) {
        L.push(`    (mostrando os 12 mais recentes de ${dt.lowFleet.events.length})`);
      }
    }

    if (dt.lowFleet.byWorker.length > 0) {
      L.push('');
      L.push('  Por maquina, o que deixou de ser entregue:');
      L.push('    maquina        h-maquina    equivalente');
      for (const w of dt.lowFleet.byWorker.slice(0, 12)) {
        L.push(
          `    ${w.label.padEnd(13)} ${w.lostEquivHours.toFixed(2).padStart(7)}    US$ ${w.usd.toFixed(2).padStart(7)}`,
        );
      }
    }

    L.push('');
    L.push(linha('A pagar se aceito', `US$ ${p.netComDesempenhoUsd.toFixed(2)}`, 28));
    if (market.usdBrl > 0) {
      L.push(linha('Em real', `R$ ${(p.netComDesempenhoUsd * market.usdBrl).toFixed(2)}`, 28));
    }
    L.push(linha('Em satoshis', emSats(p.netComDesempenhoUsd), 28));
    L.push('');
    L.push('  Este item nao esta somado ao total acima.');
    L.push('  A maquina degradada consumiu a energia quase toda, entao isto');
    L.push('  nao e devolucao de consumo como no caso da parada: e a parte');
    L.push('  do servico contratado que nao foi entregue. Fica registrado');
    L.push('  com data e medicao para conversarmos com numero, e nao com');
    L.push('  impressao.');
    L.push('');
    L.push('  As janelas de queda total estao fora desta conta: aquelas horas');
    L.push('  ja entram no credito acima, e maquina parada nao conta como');
    L.push('  entrega parcial. Nada aqui e cobrado duas vezes.');
  }

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
  /** a lista de paradas individuais cresce o mes inteiro: idem */
  const [verIndividuais, setVerIndividuais] = useState(false);
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
  const [previaDoc, setPreviaDoc] = useState<string | null>(null);
  const [previaCopiada, setPreviaCopiada] = useState(false);

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
  // O que a lista recolhida precisa mostrar sem ser aberta: o que ainda
  // esta acontecendo, e o tamanho do prejuizo acumulado.
  const individuaisEmCurso = dt
    ? dt.individualPeriods.filter((x) => x.to >= dt.until - 5 * 60_000).length
    : 0;
  const horasSozinhas = dt ? dt.individualPeriods.reduce((a, x) => a + x.soloMs, 0) / 3_600_000 : 0;

  const billExtrato = bills.find((b) => b.month === extratoMes) ?? null;
  /** A competencia anterior sustenta o desconto: a energia e paga adiantada. */
  const billAnterior = billExtrato
    ? (bills.find((b) => proximoMes(b.month) === billExtrato.month) ?? null)
    : null;
  const textoExtrato =
    billExtrato && market
      ? montarExtrato(
          billExtrato,
          billAnterior,
          market,
          data?.contractedUsdMonth ?? 0,
          account || 'nao informada',
        )
      : '';

  const copiar = async () => {
    const ok = await copiarTexto(textoExtrato);
    setCopiado(ok);
    if (ok) setTimeout(() => setCopiado(false), 2500);
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
    const ok = await copiarTexto(recibo);
    setReciboCopiado(ok);
    if (ok) setTimeout(() => setReciboCopiado(false), 2500);
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
      right={
        <div className="flex items-center gap-2">
          <span>{lancados.length ? `${lancados.length} mes(es) lancado(s)` : 'nenhum lancamento'}</span>
          {data?.previa && market && (
            <button
              className={`term-btn !py-[2px] !px-2 !text-[0.6rem] ${previaDoc ? 'inverse' : ''}`}
              onClick={() =>
                previaDoc
                  ? setPreviaDoc(null)
                  : setPreviaDoc(montarPrevia(data.previa, dt, market, account || 'nao informada'))
              }
              title="Previa da cobranca do mes seguinte, com o credito das paradas deste mes"
            >
              previa de {mesLabel(data.previa.month)}
            </button>
          )}
        </div>
      }
    >
      {/* ------------------------------------------------ previa do proximo mes */}
      {previaDoc && (
        <div className="mb-4 border border-phos/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="panel-title">
              Previa de {data?.previa ? mesLabel(data.previa.month) : ''} — mandar antes de ele faturar
            </span>
            <div className="flex items-center gap-2">
              {previaCopiada && <span className="text-[0.65rem] hot">COPIADO</span>}
              <button
                className="term-btn !py-[2px] !px-3 !text-[0.62rem]"
                onClick={async () => {
                  try {
                    await copiarTexto(previaDoc);
                    setPreviaCopiada(true);
                    setTimeout(() => setPreviaCopiada(false), 2500);
                  } catch {
                    setPreviaCopiada(false);
                  }
                }}
              >
                copiar texto
              </button>
              <button
                className="term-btn !py-[2px] !px-3 !text-[0.62rem]"
                onClick={() =>
                  data?.previa && market
                    ? setPreviaDoc(montarPrevia(data.previa, dt, market, account || 'nao informada'))
                    : undefined
                }
              >
                atualizar
              </button>
              <button className="term-btn !py-[2px] !px-3 !text-[0.62rem]" onClick={() => setPreviaDoc(null)}>
                fechar
              </button>
            </div>
          </div>
          <pre className="doc overflow-x-auto p-3 text-[0.68rem] leading-[1.45] whitespace-pre">{previaDoc}</pre>
          <p className="mt-2 text-[0.6rem] dimmer">
            O credito ainda esta sendo apurado — o mes corrente nao acabou. Perto do fim do mes o numero fica
            definitivo; use <span className="dim">atualizar</span> antes de enviar.
          </p>
        </div>
      )}
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
                  <button
                    className="flex w-full flex-wrap items-baseline gap-x-2 text-left"
                    onClick={() => setVerIndividuais(!verIndividuais)}
                    aria-expanded={verIndividuais}
                  >
                    <span className="panel-title text-crit">
                      {verIndividuais ? '▼' : '▶'} Paradas individuais ({dt.individualPeriods.length}) — fora das
                      quedas gerais
                    </span>
                    {individuaisEmCurso > 0 && (
                      <span className="blink-crit text-[0.6rem] text-crit">{individuaisEmCurso} em curso</span>
                    )}
                    <span className="ml-auto text-[0.6rem] dimmer">
                      {horasSozinhas.toFixed(1)}h sozinhas no total
                    </span>
                  </button>
                  <ul
                    className={`mt-1 max-h-56 space-y-0.5 overflow-y-auto pr-1 text-[0.68rem] ${
                      verIndividuais ? '' : 'hidden'
                    }`}
                  >
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

              {dt.lowFleet.hours > 0.05 && (
                <div className="mb-3 border border-warn/40 p-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="panel-title text-warn">
                      Fazenda abaixo de {dt.lowFleet.thresholdPct}% do nominal
                    </span>
                    <span className="text-[0.6rem] dimmer">adicional para negociacao · fora do credito</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Stat
                      label="Tempo abaixo da faixa"
                      value={`${dt.lowFleet.hours.toFixed(2)} h`}
                      sub={`${dt.lowFleet.events.length} episodio(s) na competencia`}
                      hint="Tempo de relogio com a fazenda inteira produzindo abaixo do limite"
                      tone="warn"
                    />
                    <Stat
                      label="Producao nao entregue"
                      value={`${dt.lowFleet.lostEquivHours.toFixed(2)} h`}
                      sub="horas-maquina equivalentes"
                      hint="O que faltou para o nominal, convertido em horas de maquina parada. So conta maquina ligada: a parada ja entra no credito"
                    />
                    <Stat
                      label="Equivalente sugerido"
                      value={fmtUsd(dt.lowFleet.suggestedUsd)}
                      sub={`≈ ${fmtNum(dt.lowFleet.suggestedSats)} sats`}
                      tone="warn"
                    />
                    <Stat
                      label="Maquinas envolvidas"
                      value={`${dt.lowFleet.byWorker.length}`}
                      sub="entregaram menos que o nominal"
                    />
                  </div>
                  <p className="mt-2 text-[0.62rem] dimmer">
                    Maquina degradada consome a energia quase toda, entao isto nao e devolucao de consumo como a
                    parada — e a parte do servico que nao foi entregue. Entra na previa do mes seguinte como item
                    separado, com data e medicao.
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
                      sub={`soma das ${dt.miners.length} · base do rateio`}
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
                                await copiarTexto(relatorio);
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
                          <span className="ml-1 text-[0.6rem] dimmer">
                            {b.creditEarnedSats > 0
                              ? `${b.creditGrantedSats >= b.creditEarnedSats ? '≥' : '<'} medido · abate em ${mesLabel(proximoMes(b.month))}`
                              : `abate em ${mesLabel(proximoMes(b.month))}`}
                          </span>
                        </div>
                      ) : (
                        b.creditEarnedSats > 0 && (
                          <div
                            className="text-[0.6rem] dimmer"
                            title="A energia e paga adiantada: o que parou nesta competencia so e abatido na fatura do mes seguinte."
                          >
                            a abater em {mesLabel(proximoMes(b.month))}, aguardando o host
                          </div>
                        )
                      )}
                      {b.creditAppliedSats > 0 && (
                        <div className="hot text-[0.66rem]">
                          abatido aqui − {fmtNum(b.creditAppliedSats)}
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
          A energia e paga adiantada, entao o que parou numa competencia so e abatido na fatura da seguinte: a linha{' '}
          <span className="hot">abatido aqui</span> veio do mes anterior, e a linha{' '}
          <span className="dim">a abater</span> vai para o proximo. As duas convivem na mesma competencia sem se
          anularem.{' '}
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
