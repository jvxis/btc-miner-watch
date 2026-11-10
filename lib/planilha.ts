import ExcelJS from 'exceljs';
import type { DowntimeMiner, DowntimeReport } from './energyReport';
import type { Settings } from './types';

/**
 * Planilha da fatura de energia, para quem confere a cobranca em Excel.
 *
 * Mesmo conteudo do extrato em texto, nos mesmos numeros — os dois saem do
 * mesmo relatorio montado em energyReport.ts. Na planilha, cada desconto vem
 * com a medicao que o sustenta numa aba
 * propria, e a cotacao fica numa celula editavel, entao refazer a conversao
 * nao exige pedir documento novo.
 *
 * As formulas levam o resultado junto. Um visualizador que nao recalcula —
 * previa de anexo, Drive, celular — mostraria celula vazia no lugar do total.
 */

const FONTE = 'Arial';
const USD = '"US$ "#,##0.00';
const BRL = '"R$ "#,##0.00';
const SATS = '#,##0" sats"';
const HORAS = '#,##0.00" h"';

const titulo = { name: FONTE, size: 14, bold: true };
const cabecalho = { name: FONTE, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
const normal = { name: FONTE, size: 10 };
const negrito = { name: FONTE, size: 10, bold: true };
/** azul: valor digitado, que o leitor pode trocar */
const entrada = { name: FONTE, size: 10, color: { argb: 'FF0000FF' } };
/** verde: vem de outra aba */
const vinculo = { name: FONTE, size: 10, color: { argb: 'FF008000' } };
const nota = { name: FONTE, size: 9, italic: true, color: { argb: 'FF595959' } };
const destaque = { name: FONTE, size: 12, bold: true };

const fundo = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const FUNDO_CAB = fundo('FF1F3864');
const FUNDO_TOTAL = fundo('FFD9E1F2');
const FUNDO_INPUT = fundo('FFFFF2CC');

const fino = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
const GRADE = { top: fino, left: fino, bottom: fino, right: fino };

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesLabel = (m: string) => `${MESES[Number(m.split('-')[1]) - 1]}/${m.split('-')[0].slice(2)}`;
const dm = (t: number) =>
  new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const data = (t: number) => new Date(t).toLocaleDateString('pt-BR');

function cabecalhoDe(ws: ExcelJS.Worksheet, linha: number, valores: string[], inicio = 2): void {
  valores.forEach((v, i) => {
    const c = ws.getCell(linha, inicio + i);
    c.value = v;
    c.font = cabecalho;
    c.fill = FUNDO_CAB;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = GRADE;
  });
}

function emoldurar(ws: ExcelJS.Worksheet, linha: number, de: number, ate: number, fill?: ExcelJS.Fill): void {
  for (let col = de; col <= ate; col++) {
    const c = ws.getCell(linha, col);
    c.border = GRADE;
    if (fill) c.fill = fill;
  }
}

/** Escreve um texto corrido, uma linha por item, e devolve a linha seguinte. */
function paragrafo(ws: ExcelJS.Worksheet, linha: number, linhas: string[], col = 2): number {
  for (const t of linhas) {
    ws.getCell(linha, col).value = t;
    ws.getCell(linha, col).font = nota;
    linha += 1;
  }
  return linha;
}

export interface DadosPlanilha {
  /** competencia da fatura, ex.: 2026-10 */
  month: string;
  /** medicao que sustenta o desconto — a competencia anterior */
  base: DowntimeReport;
  baseMonth: string;
  contratoUsd: number;
  market: { btcUsd: number; usdBrl: number; updatedAt: number };
  settings: Settings;
  conta: string;
}

export async function montarPlanilha(d: DadosPlanilha): Promise<ArrayBuffer> {
  const { base, market } = d;
  const maquinas = [...base.miners].sort((a, b) => a.label.localeCompare(b.label));
  const desempenho = [...base.lowFleet.byWorker].sort((a, b) => a.label.localeCompare(b.label));
  const precoUnitario = Math.max(...maquinas.map((m: DowntimeMiner) => m.monthlyUsd), 0);
  const fatia = Math.min(100, Math.max(0, d.settings.performanceSplitPct)) / 100;

  // Linhas conhecidas de antemao, para as referencias entre abas fecharem.
  const P0 = 7;
  const P_TOTAL = P0 + maquinas.length;
  const D0 = 9;
  const DN = D0 + desempenho.length - 1;
  const Q0 = 6;

  const creditoUsd = base.combinedCreditUsd;
  const desempenhoUsd = base.lowFleet.suggestedUsd;
  const parteDesempenho = desempenhoUsd * fatia;
  const totalUsd = d.contratoUsd - creditoUsd - parteDesempenho;
  const sats = (usd: number) => (market.btcUsd > 0 ? Math.round((usd / market.btcUsd) * 1e8) : 0);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'miner-watch';
  wb.created = new Date();

  // ======================================================== aba RESUMO
  const ws = wb.addWorksheet('Resumo', { views: [{ showGridLines: false }] });
  ws.getColumn('A').width = 3;
  ws.getColumn('B').width = 50;
  ws.getColumn('C').width = 16;
  ws.getColumn('D').width = 16;
  ws.getColumn('E').width = 18;

  ws.getCell('B2').value = `COBRANCA DE ENERGIA — COMPETENCIA ${mesLabel(d.month).toUpperCase()}`;
  ws.getCell('B2').font = titulo;
  ws.getCell('B3').value = `Conta na pool: ${d.conta} · ${maquinas.length} maquinas · emitido em ${data(Date.now())}`;
  ws.getCell('B3').font = nota;

  ws.getCell('B5').value = 'COTACAO E CONTRATO';
  ws.getCell('B5').font = negrito;
  const entradas: [string, number, string, number][] = [
    ['Bitcoin (US$)', market.btcUsd, '"US$ "#,##0', 6],
    ['Dolar (R$)', market.usdBrl, '"R$ "#,##0.0000', 7],
    ['Maquinas no contrato', maquinas.length, '#,##0', 8],
    ['Contrato por maquina (US$/mes)', precoUnitario, USD, 9],
  ];
  for (const [rotulo, valor, fmt, ln] of entradas) {
    ws.getCell(ln, 2).value = rotulo;
    ws.getCell(ln, 2).font = normal;
    const c = ws.getCell(ln, 3);
    c.value = valor;
    c.font = entrada;
    c.numFmt = fmt;
    c.fill = FUNDO_INPUT;
    c.border = GRADE;
  }
  ws.getCell('E6').value = 'Celulas em amarelo sao editaveis;';
  ws.getCell('E6').font = nota;
  ws.getCell('E7').value = 'o resto da planilha recalcula sozinho.';
  ws.getCell('E7').font = nota;
  ws.getCell('B10').value = `Cotacao lida em ${dm(market.updatedAt)}`;
  ws.getCell('B10').font = nota;

  cabecalhoDe(ws, 12, ['Composicao da fatura', 'US$', 'R$', 'Satoshis']);
  const itens: [string, string, number, Partial<ExcelJS.Font>][] = [
    [`Contrato de energia de ${mesLabel(d.month)}`, 'C8*C9', d.contratoUsd, normal],
    [`(-) Credito de indisponibilidade de ${mesLabel(d.baseMonth)}`, `-Paradas!E${P_TOTAL}`, -creditoUsd, vinculo],
    [
      `(-) ${d.settings.performanceSplitPct}% do tempo abaixo do nominal em ${mesLabel(d.baseMonth)}`,
      '-Desempenho!D6',
      -parteDesempenho,
      vinculo,
    ],
  ];
  let L = 13;
  for (const [rotulo, formula, valor, fonte] of itens) {
    ws.getCell(L, 2).value = rotulo;
    ws.getCell(L, 2).font = normal;
    const c = ws.getCell(L, 3);
    c.value = { formula, result: valor };
    c.font = fonte;
    c.numFmt = USD;
    const r = ws.getCell(L, 4);
    r.value = { formula: `C${L}*$C$7`, result: valor * market.usdBrl };
    r.font = normal;
    r.numFmt = BRL;
    const s = ws.getCell(L, 5);
    s.value = { formula: `ROUND(C${L}/$C$6*100000000,0)`, result: sats(valor) };
    s.font = normal;
    s.numFmt = SATS;
    emoldurar(ws, L, 2, 5);
    L += 1;
  }

  const LT = L;
  ws.getCell(LT, 2).value = 'TOTAL A PAGAR';
  ws.getCell(LT, 2).font = destaque;
  const totais: [number, string, number, string][] = [
    [3, `SUM(C13:C${LT - 1})`, totalUsd, USD],
    [4, `C${LT}*$C$7`, totalUsd * market.usdBrl, BRL],
    [5, `ROUND(C${LT}/$C$6*100000000,0)`, sats(totalUsd), SATS],
  ];
  for (const [col, formula, result, fmt] of totais) {
    const c = ws.getCell(LT, col);
    c.value = { formula, result };
    c.font = destaque;
    c.numFmt = fmt;
  }
  emoldurar(ws, LT, 2, 5, FUNDO_TOTAL);

  L = LT + 2;
  ws.getCell(L, 2).value = `O QUE SUSTENTA CADA DESCONTO (medido em ${mesLabel(d.baseMonth)})`;
  ws.getCell(L, 2).font = negrito;
  L += 1;
  cabecalhoDe(ws, L, ['Medicao', 'Quantidade', 'US$', 'Observacao']);
  L += 1;
  const horasCobraveis = base.miners
    .filter((m: DowntimeMiner) => m.monthlyUsd > 0)
    .reduce((a: number, m: DowntimeMiner) => a + m.downHours, 0);
  const medicoes: [string, number, string | null, number | null, string][] = [
    [
      'Fazenda inteira parada (tempo de relogio)',
      base.combinedOutageHours,
      `-C${LT - 2}`,
      creditoUsd,
      `${base.measuredPeriods.length} quedas, listadas na aba Quedas`,
    ],
    ['Horas-maquina paradas (base do rateio)', base.totalDownHours, null, null, 'soma do tempo parado de cada maquina'],
    [
      `Tempo abaixo de ${base.lowFleet.thresholdPct}% do nominal`,
      base.lowFleet.hours,
      null,
      null,
      `${base.lowFleet.events.length} episodios, fora das quedas acima`,
    ],
    [
      'Producao nao entregue',
      base.lowFleet.lostEquivHours,
      'Desempenho!D4',
      desempenhoUsd,
      `horas-maquina equivalentes; ${d.settings.performanceSplitPct}% entra na fatura`,
    ],
  ];
  for (const [rotulo, qtd, formula, valor, obs] of medicoes) {
    ws.getCell(L, 2).value = rotulo;
    ws.getCell(L, 2).font = normal;
    const c = ws.getCell(L, 3);
    c.value = qtd;
    c.font = normal;
    c.numFmt = HORAS;
    if (formula && valor !== null) {
      const v = ws.getCell(L, 4);
      v.value = { formula, result: valor };
      v.font = vinculo;
      v.numFmt = USD;
    }
    ws.getCell(L, 5).value = obs;
    ws.getCell(L, 5).font = nota;
    emoldurar(ws, L, 2, 5);
    L += 1;
  }
  if (horasCobraveis < base.totalDownHours - 0.005) {
    ws.getCell(L, 2).value = `Das horas paradas, ${horasCobraveis.toFixed(2)} h sao cobraveis — maquina em cortesia nao gera credito.`;
    ws.getCell(L, 2).font = nota;
    L += 1;
  }

  L += 1;
  ws.getCell(L, 2).value = 'A PROPOSTA';
  ws.getCell(L, 2).font = negrito;
  L += 1;
  paragrafo(ws, L, [
    'O credito de indisponibilidade e devolucao de consumo: maquina parada nao gasta energia, entao',
    'as horas paradas saem do contrato do mes. Esse item nao esta em discussao.',
    '',
    'O tempo abaixo do nominal e outra coisa. A maquina ficou ligada, consumiu a energia quase toda',
    'e entregou menos — nao e devolucao de consumo, e servico contratado que nao foi entregue. Como',
    `a causa pode estar dos dois lados, a perda entra pela ${d.settings.performanceSplitPct > 0 ? 'fatia combinada' : 'fatia definida'}`,
    `de ${d.settings.performanceSplitPct}%, em linha separada.`,
    '',
    'Todos os numeros vem de medicao propria a cada minuto, com data e hora, detalhada nas abas',
    'seguintes. O valor em satoshis vale para a cotacao declarada acima; na hora do pagamento a',
    'conversao e refeita pela cotacao do momento.',
  ]);

  // ======================================================= aba PARADAS
  const ws2 = wb.addWorksheet('Paradas', { views: [{ showGridLines: false }] });
  ws2.getColumn('A').width = 3;
  ws2.getColumn('B').width = 16;
  ws2.getColumn('C').width = 16;
  ws2.getColumn('D').width = 18;
  ws2.getColumn('E').width = 16;
  ws2.getColumn('F').width = 38;

  ws2.getCell('B2').value = `CREDITO DE INDISPONIBILIDADE — ${mesLabel(d.baseMonth).toUpperCase()}`;
  ws2.getCell('B2').font = titulo;
  ws2.getCell('B3').value =
    `Medido de ${dm(base.since)} a ${dm(base.until)} · cobertura ${base.coverageHours.toFixed(1)} h de ${base.hoursInMonth.toFixed(0)} h do mes`;
  ws2.getCell('B3').font = nota;
  ws2.getCell('B4').value = 'Horas no mes';
  ws2.getCell('B4').font = normal;
  const hm = ws2.getCell('C4');
  hm.value = Math.round(base.hoursInMonth);
  hm.font = entrada;
  hm.numFmt = '#,##0';
  hm.fill = FUNDO_INPUT;
  hm.border = GRADE;
  ws2.getCell('D4').value = 'divisor do custo por hora';
  ws2.getCell('D4').font = nota;

  cabecalhoDe(ws2, 6, ['Maquina', 'Horas paradas', 'Contrato US$/mes', 'Credito US$', 'Observacao']);
  let linha = P0;
  for (const m of maquinas) {
    ws2.getCell(linha, 2).value = m.label;
    ws2.getCell(linha, 2).font = normal;
    const h = ws2.getCell(linha, 3);
    h.value = m.downHours;
    h.font = normal;
    h.numFmt = HORAS;
    const u = ws2.getCell(linha, 4);
    u.value = m.monthlyUsd;
    u.font = normal;
    u.numFmt = USD;
    const cr = ws2.getCell(linha, 5);
    cr.value = { formula: `C${linha}*D${linha}/$C$4`, result: m.creditUsd };
    cr.font = normal;
    cr.numFmt = USD;
    if (m.monthlyUsd <= 0) {
      ws2.getCell(linha, 6).value = 'em cortesia: sem contrato, sem credito';
      ws2.getCell(linha, 6).font = nota;
    }
    emoldurar(ws2, linha, 2, 6);
    linha += 1;
  }
  ws2.getCell(P_TOTAL, 2).value = 'TOTAL';
  ws2.getCell(P_TOTAL, 2).font = negrito;
  const th = ws2.getCell(P_TOTAL, 3);
  th.value = { formula: `SUM(C${P0}:C${P_TOTAL - 1})`, result: base.totalDownHours };
  th.font = negrito;
  th.numFmt = HORAS;
  const tc = ws2.getCell(P_TOTAL, 5);
  tc.value = { formula: `SUM(E${P0}:E${P_TOTAL - 1})`, result: creditoUsd };
  tc.font = negrito;
  tc.numFmt = USD;
  emoldurar(ws2, P_TOTAL, 2, 6, FUNDO_TOTAL);

  linha = P_TOTAL + 2;
  ws2.getCell(linha, 2).value = 'Fazenda inteira parada';
  ws2.getCell(linha, 2).font = negrito;
  const fp = ws2.getCell(linha, 3);
  fp.value = base.combinedOutageHours;
  fp.font = negrito;
  fp.numFmt = HORAS;
  ws2.getCell(linha, 4).value = `${base.measuredPeriods.length} quedas — ver aba Quedas`;
  ws2.getCell(linha, 4).font = nota;
  linha = paragrafo(ws2, linha + 2, [
    'A soma dos periodos listados na aba Quedas da uma fracao de minuto a mais: cada periodo e',
    'desenhado a partir da leitura anterior a primeira sem shares, e esse minuto de entrada e',
    'atribuido, nao medido. O valor acima e o tempo efetivamente medido.',
    '',
    'Sao duas contagens diferentes, e confundi-las infla o pedido: horas-maquina paradas e a soma',
    'do tempo de cada maquina; fazenda parada e tempo de relogio com todas paradas ao mesmo tempo.',
    'Uma maquina que cai sozinha move a primeira e nao move a segunda.',
    '',
    'O credito se apura maquina a maquina, pelo custo por hora da propria maquina. Maquina parada',
    'nao consome energia, entao as horas paradas saem do contrato do mes.',
  ]);

  // ==================================================== aba DESEMPENHO
  const ws3 = wb.addWorksheet('Desempenho', { views: [{ showGridLines: false }] });
  ws3.getColumn('A').width = 3;
  ws3.getColumn('B').width = 16;
  ws3.getColumn('C').width = 24;
  ws3.getColumn('D').width = 18;
  ws3.getColumn('E').width = 40;

  ws3.getCell('B2').value = `TEMPO ABAIXO DO NOMINAL — ${mesLabel(d.baseMonth).toUpperCase()}`;
  ws3.getCell('B2').font = titulo;
  ws3.getCell('B4').value = 'Producao nao entregue';
  ws3.getCell('B4').font = negrito;
  const pn = ws3.getCell('C4');
  pn.value = { formula: `SUM(C${D0}:C${DN})`, result: base.lowFleet.lostEquivHours };
  pn.font = negrito;
  pn.numFmt = HORAS;
  const pu = ws3.getCell('D4');
  pu.value = { formula: `SUM(D${D0}:D${DN})`, result: desempenhoUsd };
  pu.font = negrito;
  pu.numFmt = USD;
  ws3.getCell('E4').value = 'horas-maquina equivalentes';
  ws3.getCell('E4').font = nota;

  ws3.getCell('B5').value = `Fazenda abaixo de ${base.lowFleet.thresholdPct}% do nominal`;
  ws3.getCell('B5').font = normal;
  const fb = ws3.getCell('C5');
  fb.value = base.lowFleet.hours;
  fb.font = normal;
  fb.numFmt = HORAS;
  ws3.getCell('E5').value = `${base.lowFleet.events.length} episodios, fora das janelas de queda total`;
  ws3.getCell('E5').font = nota;

  ws3.getCell('B6').value = `RATEIO ACORDADO: ${d.settings.performanceSplitPct}% da perda`;
  ws3.getCell('B6').font = negrito;
  const rt = ws3.getCell('D6');
  rt.value = { formula: `D4*${fatia}`, result: parteDesempenho };
  rt.font = destaque;
  rt.numFmt = USD;
  rt.fill = FUNDO_TOTAL;
  rt.border = GRADE;
  ws3.getCell('E6').value = 'e este valor que entra no Resumo';
  ws3.getCell('E6').font = nota;

  cabecalhoDe(ws3, 8, ['Maquina', 'Nao entregue (h-maquina)', 'Equivalente US$', '']);
  linha = D0;
  for (const w of desempenho) {
    ws3.getCell(linha, 2).value = w.label;
    ws3.getCell(linha, 2).font = normal;
    const h = ws3.getCell(linha, 3);
    h.value = w.lostEquivHours;
    h.font = normal;
    h.numFmt = HORAS;
    const u = ws3.getCell(linha, 4);
    u.value = w.usd;
    u.font = normal;
    u.numFmt = USD;
    emoldurar(ws3, linha, 2, 5);
    linha += 1;
  }
  paragrafo(ws3, DN + 2, [
    'Maquina degradada consome a energia quase toda e entrega menos. Por isso este item nao e',
    'devolucao de consumo como o credito de parada: e a parte do servico contratado que nao foi',
    'entregue — tese diferente, e por isso vem separado.',
    '',
    'As janelas de queda total estao fora desta conta: aquelas horas ja entram no credito, e',
    'maquina parada nao conta como entrega parcial. Nada aqui e cobrado duas vezes.',
    '',
    'A perda e medida como a fracao do nominal que faltou, vezes o tempo — uma maquina a 60% do',
    'nominal por uma hora perde 0,4 hora-equivalente — e cada hora e valorada pelo custo horario',
    'da propria maquina, o mesmo criterio do credito de parada.',
  ]);

  // ======================================================== aba QUEDAS
  const ws4 = wb.addWorksheet('Quedas', { views: [{ showGridLines: false }] });
  ws4.getColumn('A').width = 3;
  ws4.getColumn('B').width = 20;
  ws4.getColumn('C').width = 20;
  ws4.getColumn('D').width = 14;
  ws4.getColumn('E').width = 26;

  ws4.getCell('B2').value = `QUEDAS TOTAIS DA FAZENDA — ${mesLabel(d.baseMonth).toUpperCase()}`;
  ws4.getCell('B2').font = titulo;
  ws4.getCell('B3').value = 'Periodos sem nenhuma maquina enviando share e com o hashrate da conta no chao.';
  ws4.getCell('B3').font = nota;

  cabecalhoDe(ws4, 5, ['Inicio', 'Fim', 'Minutos', 'Origem']);
  const eventos = [
    ...base.measuredPeriods.map((p) => ({ ...p, fonte: 'medido pelo coletor' })),
    ...base.importedPeriods.map((p) => ({ ...p, fonte: 'historico da pool' })),
  ].sort((a, b) => a.from - b.from);
  linha = Q0;
  for (const e of eventos) {
    ws4.getCell(linha, 2).value = new Date(e.from).toLocaleString('pt-BR');
    ws4.getCell(linha, 2).font = normal;
    ws4.getCell(linha, 3).value = new Date(e.to).toLocaleString('pt-BR');
    ws4.getCell(linha, 3).font = normal;
    const mn = ws4.getCell(linha, 4);
    mn.value = e.ms / 60000;
    mn.font = normal;
    mn.numFmt = '#,##0.0';
    ws4.getCell(linha, 5).value = e.fonte;
    ws4.getCell(linha, 5).font = normal;
    emoldurar(ws4, linha, 2, 5);
    linha += 1;
  }
  const minutos = eventos.reduce((a, e) => a + e.ms / 60000, 0);
  ws4.getCell(linha, 2).value = 'TOTAL (minutos)';
  ws4.getCell(linha, 2).font = negrito;
  const tm = ws4.getCell(linha, 4);
  tm.value = { formula: `SUM(D${Q0}:D${linha - 1})`, result: minutos };
  tm.font = negrito;
  tm.numFmt = '#,##0.0';
  emoldurar(ws4, linha, 2, 5, FUNDO_TOTAL);
  ws4.getCell(linha + 1, 2).value = 'TOTAL (horas)';
  ws4.getCell(linha + 1, 2).font = negrito;
  const th2 = ws4.getCell(linha + 1, 4);
  th2.value = { formula: `D${linha}/60`, result: minutos / 60 };
  th2.font = negrito;
  th2.numFmt = '#,##0.00';

  // writeBuffer devolve o ArrayBuffer do exceljs, que serve direto de corpo
  // de resposta; o tipo dele nao bate com o do Node, dai a conversao.
  return (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}
