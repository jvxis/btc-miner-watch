'use client';

import { useState } from 'react';
import { CumulativeChart, MarginChart, MonthlyPnlChart } from '@/components/Charts';
import { calcularLinhas, mesLabel, totalizar, type Linha } from '@/lib/pnl';
import { KeyValue, Meter, Panel, Stat } from '@/components/ui';
import { useEnergyBills } from '@/lib/client';
import { fmtBtc, fmtMoney, fmtNum, fmtPct, fmtUsd } from '@/lib/format';

export default function PnlPage() {
  const { data, error } = useEnergyBills();
  /** esconde competencias cujo custo ainda e estimativa do contrato */
  const [soRealizado, setSoRealizado] = useState(false);

  if (error) return <Panel title="Erro"><p className="text-crit text-sm">{String(error.message)}</p></Panel>;
  if (!data) return <p className="dim caret py-8">APURANDO RESULTADO</p>;

  const market = data.market;
  const cur: 'BRL' | 'USD' = data.settings?.primaryCurrency ?? 'BRL';
  const price = cur === 'BRL' ? market.btcBrl : market.btcUsd;
  const fiat = (sats: number) => (sats / 1e8) * price;

  const todas = calcularLinhas(data.bills ?? []);
  const linhas: Linha[] = soRealizado ? todas.filter((l) => l.energiaReal) : todas;

  if (linhas.length === 0) {
    return (
      <Panel title="Resultado mensal">
        <p className="dim text-sm">
          {soRealizado
            ? 'Nenhuma competencia com fatura lancada ainda. Lance o valor pago na carteira.'
            : 'Sem competencias apuradas.'}
        </p>
        {soRealizado && (
          <button className="term-btn mt-3" onClick={() => setSoRealizado(false)}>
            mostrar tambem as estimadas
          </button>
        )}
      </Panel>
    );
  }

  const acc = totalizar(linhas);
  const realizado = totalizar(todas.filter((l) => l.energiaReal));
  const estimadas = todas.filter((l) => !l.energiaReal).length;
  const fechados = linhas.filter((l) => !l.partial);
  const melhor = [...fechados].sort((a, b) => b.margemPct - a.margemPct)[0];
  const pior = [...fechados].sort((a, b) => a.margemPct - b.margemPct)[0];

  const serie = linhas.map((l) => ({
    mes: mesLabel(l.month),
    minerado: l.minedSats,
    energia: l.energiaLiquidaSats,
    lucro: l.lucroSats,
    estimado: !l.energiaReal,
  }));
  const margens = linhas.map((l) => ({ mes: mesLabel(l.month), margem: l.margemPct }));
  const acumulado = linhas.reduce<{ mes: string; acumulado: number }[]>((serieAcc, l) => {
    const anterior = serieAcc.length > 0 ? serieAcc[serieAcc.length - 1].acumulado : 0;
    return [...serieAcc, { mes: mesLabel(l.month), acumulado: anterior + l.lucroSats }];
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl hot">RESULTADO (P&amp;L)</h1>
        <span className="dim text-[0.7rem]">apurado por competencia, em satoshis</span>
        <div className="ml-auto flex gap-1">
          <button
            className={`term-btn !py-[3px] !px-2 ${!soRealizado ? 'inverse' : ''}`}
            onClick={() => setSoRealizado(false)}
          >
            TODAS ({todas.length})
          </button>
          <button
            className={`term-btn !py-[3px] !px-2 ${soRealizado ? 'inverse' : ''}`}
            onClick={() => setSoRealizado(true)}
          >
            SO REALIZADO ({todas.filter((l) => l.energiaReal).length})
          </button>
        </div>
      </div>

      {!soRealizado && estimadas > 0 && (
        <div className="panel border-warn/40 px-3 py-2 text-[0.68rem] text-warn">
          {estimadas} competencia(s) ainda sem fatura lancada usam a estimativa do contrato atual. Se o parque de
          maquinas era menor naquele periodo, o custo aparece inflado — lance a fatura para corrigir, ou use o
          filtro SO REALIZADO.
        </div>
      )}

      {/* ---------------------------------------------- totais */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Panel>
          <Stat
            label="Minerado"
            value={`${fmtNum(acc.minerado)} sats`}
            sub={`${fmtBtc(acc.minerado / 1e8)} BTC · ${fmtMoney(fiat(acc.minerado), cur, true)}`}
            size="lg"
          />
        </Panel>
        <Panel>
          <Stat
            label="Energia liquida"
            value={`${fmtNum(acc.energia)} sats`}
            sub={
              acc.desconto > 0
                ? `${fmtMoney(fiat(acc.energia), cur, true)} · com ${fmtNum(acc.desconto)} de desconto`
                : fmtMoney(fiat(acc.energia), cur, true)
            }
            size="lg"
          />
        </Panel>
        <Panel>
          <Stat
            label="Resultado acumulado"
            value={`${fmtNum(acc.lucro)} sats`}
            sub={fmtMoney(fiat(acc.lucro), cur, true)}
            tone={acc.lucro < 0 ? 'crit' : 'normal'}
            size="lg"
          />
        </Panel>
        <Panel>
          <Stat
            label="Margem"
            value={fmtPct(acc.margem, 1)}
            sub={
              melhor && pior && melhor !== pior
                ? `melhor ${mesLabel(melhor.month)} ${fmtPct(melhor.margemPct, 0)} · pior ${mesLabel(pior.month)} ${fmtPct(pior.margemPct, 0)}`
                : 'apenas uma competencia fechada'
            }
            tone={acc.margem < 0 ? 'crit' : acc.margem < 25 ? 'warn' : 'normal'}
            size="lg"
          />
          <div className="mt-2">
            <Meter
              ratio={Math.max(0, acc.margem) / 100}
              segments={24}
              height={7}
              tone={acc.margem < 0 ? 'crit' : acc.margem < 25 ? 'warn' : 'normal'}
            />
          </div>
        </Panel>
        <Panel>
          <Stat
            label="Preco da energia"
            value={acc.usdPerKwh !== null ? `US$ ${acc.usdPerKwh.toFixed(4)}` : '—'}
            sub={
              acc.usdPerKwh !== null
                ? `por kWh · R$ ${(acc.usdPerKwh * market.usdBrl).toFixed(3)} · ${fmtNum(acc.kwh, 0)} kWh`
                : 'sem consumo apurado'
            }
            size="lg"
            hint="Custo total dividido pelo consumo estimado com a potencia configurada"
          />
          <p className="mt-2 text-[0.6rem] dimmer">
            Consumo estimado pela potencia configurada em CONFIG. Se o consumo real das maquinas for outro, este
            preco muda na mesma proporcao.
          </p>
        </Panel>
      </div>

      {/* ---------------------------------------------- graficos */}
      <Panel title="Minerado x energia por competencia" right="linha = resultado liquido">
        <MonthlyPnlChart data={serie} height={300} />
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[0.62rem] dimmer">
          <span>█ minerado</span>
          <span>▓ energia da fatura lancada</span>
          <span>░ energia estimada pelo contrato</span>
          <span>— resultado liquido</span>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Margem por competencia">
          <MarginChart data={margens} height={220} />
        </Panel>
        <Panel title="Resultado acumulado" right="satoshis somados mes a mes">
          <CumulativeChart data={acumulado} height={220} />
        </Panel>
      </div>

      {/* ---------------------------------------------- tabela */}
      <Panel title="Detalhamento por competencia" bodyClassName="p-0 overflow-x-auto">
        <table className="term">
          <thead>
            <tr>
              <th>Competencia</th>
              <th>Minerado (sats)</th>
              <th>Energia (sats)</th>
              <th>Desconto</th>
              <th>Energia liquida</th>
              <th>Resultado (sats)</th>
              <th>Margem</th>
              <th>US$/kWh</th>
              <th>Minerado {cur}</th>
              <th>Resultado {cur}</th>
            </tr>
          </thead>
          <tbody>
            {[...linhas].reverse().map((l) => (
              <tr key={l.month}>
                <td className="hot">
                  {mesLabel(l.month)}
                  {l.partial && <span className="dimmer ml-1 text-[0.6rem]">em curso</span>}
                </td>
                <td>{fmtNum(l.minedSats)}</td>
                <td
                  className={l.energiaReal ? '' : 'dim'}
                  title={l.energiaReal ? 'fatura lancada' : 'estimativa pelo contrato'}
                >
                  {l.energiaReal ? '' : '≈ '}
                  {fmtNum(l.energiaSats)}
                </td>
                <td className={l.descontoSats > 0 ? 'text-warn' : 'dimmer'}>
                  {l.descontoSats > 0 ? `− ${fmtNum(l.descontoSats)}` : '—'}
                </td>
                <td>{fmtNum(l.energiaLiquidaSats)}</td>
                <td className={l.lucroSats < 0 ? 'text-crit' : 'hot'}>{fmtNum(l.lucroSats)}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <span className={l.margemPct < 0 ? 'text-crit' : l.margemPct < 25 ? 'text-warn' : ''}>
                      {fmtPct(l.margemPct, 1)}
                    </span>
                    <div className="w-20">
                      <Meter
                        ratio={Math.max(0, l.margemPct) / 100}
                        segments={12}
                        height={6}
                        tone={l.margemPct < 0 ? 'crit' : l.margemPct < 25 ? 'warn' : 'normal'}
                      />
                    </div>
                  </div>
                </td>
                <td
                  className={l.energiaReal ? '' : 'dim'}
                  title={
                    l.usdPerKwh !== null
                      ? `${fmtNum(l.kwhMonth, 0)} kWh estimados · R$ ${(l.usdPerKwh * market.usdBrl).toFixed(3)}/kWh`
                      : ''
                  }
                >
                  {l.usdPerKwh !== null ? `${l.energiaReal ? '' : '≈ '}${l.usdPerKwh.toFixed(4)}` : '—'}
                </td>
                <td>{fmtMoney(fiat(l.minedSats), cur, true)}</td>
                <td className={l.lucroSats < 0 ? 'text-crit' : ''}>{fmtMoney(fiat(l.lucroSats), cur, true)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="dim">TOTAL</td>
              <td className="hot">{fmtNum(acc.minerado)}</td>
              <td />
              <td className={acc.desconto > 0 ? 'text-warn' : ''}>
                {acc.desconto > 0 ? `− ${fmtNum(acc.desconto)}` : '—'}
              </td>
              <td className="hot">{fmtNum(acc.energia)}</td>
              <td className={acc.lucro < 0 ? 'text-crit' : 'hot'}>{fmtNum(acc.lucro)}</td>
              <td>{fmtPct(acc.margem, 1)}</td>
              <td className="hot">{acc.usdPerKwh !== null ? acc.usdPerKwh.toFixed(4) : '—'}</td>
              <td className="hot">{fmtMoney(fiat(acc.minerado), cur, true)}</td>
              <td className={acc.lucro < 0 ? 'text-crit' : 'hot'}>{fmtMoney(fiat(acc.lucro), cur, true)}</td>
            </tr>
          </tfoot>
        </table>
      </Panel>

      {/* ---------------------------------------------- notas */}
      <Panel title="Como este resultado e apurado">
        <div className="grid gap-x-8 sm:grid-cols-2">
          <div>
            <KeyValue k="Unidade base" v="satoshis" />
            <KeyValue k="Cotacao usada" v={`${fmtMoney(price, cur, true)} / BTC`} />
            <KeyValue
              k="Competencias realizadas"
              v={`${todas.filter((l) => l.energiaReal).length} de ${todas.length}`}
            />
            <KeyValue
              k="Resultado so do realizado"
              v={`${fmtNum(realizado.lucro)} sats`}
              tone={realizado.lucro < 0 ? 'crit' : undefined}
            />
            <KeyValue
              k="Preco medio da energia"
              v={acc.usdPerKwh !== null ? `US$ ${acc.usdPerKwh.toFixed(4)} / kWh` : '—'}
            />
            <KeyValue
              k="Consumo apurado"
              v={`${fmtNum(acc.kwh, 0)} kWh · ${fmtUsd(acc.custoUsd, true)}`}
            />
          </div>
          <div className="mt-2 space-y-1 text-[0.66rem] dimmer sm:mt-0">
            <p>
              A receita vem do historico diario da pool e, para meses que ele nao alcanca, da soma dos pagamentos
              recebidos. O custo e a fatura lancada; enquanto ela nao entra, o contrato configurado serve de
              estimativa e a linha fica marcada com <span className="dim">≈</span>.
            </p>
            <p>
              O desconto por indisponibilidade ja esta abatido da energia liquida. Valores em {cur} usam a cotacao de
              agora, nao a da epoca — a pool nao guarda preco historico.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
