'use client';

import { useState } from 'react';
import { Gauge, KeyValue, Meter, Panel, Stat } from '@/components/ui';
import { useNow, useOverview } from '@/lib/client';
import { fmtBrl, fmtDuration, fmtHash, fmtHashHs, fmtMoney, fmtNum, fmtPct } from '@/lib/format';

export default function NetworkPage() {
  const { data, error } = useOverview();
  const now = useNow();
  const [priceMult, setPriceMult] = useState(100);
  /** null = usa a tarifa configurada; qualquer numero e um cenario manual. */
  const [tariffOverride, setTariffOverride] = useState<number | null>(null);
  const [diffMult, setDiffMult] = useState(100);

  if (error) return <Panel title="Erro"><p className="text-crit text-sm">{String(error.message)}</p></Panel>;
  if (!data) return <p className="dim caret py-8">CARREGANDO DADOS DA REDE</p>;

  const tariff = tariffOverride ?? data.settings.tariffBrl;
  const { market: k, totals: t } = data;
  const ref = now || data.generatedAt;
  const halvingIn = k.halvingDate ? (k.halvingDate - ref) / 1000 : null;
  const retargetIn = k.difficultyRetargetDate ? (k.difficultyRetargetDate - ref) / 1000 : null;

  // ------------------------------------------------------------- simulador
  const simPriceBrl = k.btcBrl * (priceMult / 100);
  const simRevenueBtc = t.revenueDayBtc * (100 / diffMult);
  const simRevenueBrl = simRevenueBtc * simPriceBrl;
  // Contratos fechados nao mudam com a tarifa; so o consumo cobrado por kWh muda.
  const simCostBrl = t.costDayFixedBrl + t.kwhDayTariffed * tariff;
  const simProfit = simRevenueBrl - simCostBrl;
  const simMargin = simRevenueBrl > 0 ? (simProfit / simRevenueBrl) * 100 : 0;
  const simBreakeven = simRevenueBtc > 0 ? simCostBrl / simRevenueBtc : 0;
  /** Tarifa maxima suportada antes do prejuizo, no cenario simulado. */
  const maxTariff = t.kwhDayTariffed > 0 ? (simRevenueBrl - t.costDayFixedBrl) / t.kwhDayTariffed : 0;
  const allFixed = t.kwhDayTariffed <= 0;

  // O custo esta preso ao dolar: em reais ele nao se mexe com o preco do BTC,
  // mas em satoshis encolhe quando o bitcoin sobe.
  const simBtcUsd = k.btcUsd * (priceMult / 100);
  const simCostUsd = k.usdBrl > 0 ? simCostBrl / k.usdBrl : 0;
  const simCostSats = simBtcUsd > 0 ? (simCostUsd / simBtcUsd) * 1e8 : 0;
  const simRevenueSats = simRevenueBtc * 1e8;
  const simProfitSats = simRevenueSats - simCostSats;
  const simBurn = simRevenueSats > 0 ? (simCostSats / simRevenueSats) * 100 : 0;

  const scenarios = [-40, -30, -20, -10, 0, 10, 20, 30, 40];

  // Sensibilidade ao custo de energia: por tarifa (kWh) ou por contrato fechado (USD/mes).
  const tariffScenarios = [0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 0.85, 1.0, 1.2].map((tf) => {
    const cost = t.costDayFixedBrl + t.kwhDayTariffed * tf;
    return {
      key: `t${tf}`,
      label: `R$ ${tf.toFixed(2)}`,
      cost,
      profit: t.revenueDayBrl - cost,
      current: Math.abs(tf - data.settings.tariffBrl) < 0.001,
    };
  });

  const minerCount = Math.max(1, data.miners.length);
  const currentFixedUsd = k.usdBrl > 0 ? ((t.costDayFixedBrl * 30) / minerCount) / k.usdBrl : 0;
  const fixedScenarios = scenarios.map((p) => {
    const usdPerMiner = currentFixedUsd * (1 + p / 100);
    const cost = ((usdPerMiner * minerCount) / 30) * k.usdBrl;
    return {
      key: `f${p}`,
      label: `US$ ${usdPerMiner.toFixed(0)} (${p > 0 ? '+' : ''}${p}%)`,
      cost,
      profit: t.revenueDayBrl - cost,
      current: p === 0,
    };
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel title="Preco do Bitcoin">
          <Stat
            label="BRL"
            value={fmtBrl(k.btcBrl, true)}
            sub={
              <span className={k.change24hBrl < 0 ? 'text-crit' : 'hot'}>
                {k.change24hBrl >= 0 ? '▲' : '▼'} {Math.abs(k.change24hBrl).toFixed(2)}% em 24h
              </span>
            }
            size="lg"
          />
          <div className="mt-2 space-y-0.5">
            <KeyValue k="USD" v={fmtMoney(k.btcUsd, 'USD', true)} />
            <KeyValue k="Cambio USD/BRL" v={k.usdBrl.toFixed(3)} />
            <KeyValue k="Atualizado" v={`${fmtDuration((ref - k.updatedAt) / 1000)} atras`} />
          </div>
        </Panel>

        <Panel title="Hashrate da rede">
          <Stat label="Total estimado" value={fmtHashHs(k.networkHashrate, 1)} sub="media movel de 3 dias" size="lg" />
          <div className="mt-2 space-y-0.5">
            <KeyValue k="Dificuldade" v={k.difficulty ? `${(k.difficulty / 1e12).toFixed(2)} T` : '—'} />
            <KeyValue k="Sua fatia" v={t.networkSharePpm !== null ? `${t.networkSharePpm.toFixed(2)} ppm` : '—'} />
            <KeyValue
              k="Sua fatia (%)"
              v={t.networkSharePpm !== null ? `${(t.networkSharePpm / 1e4).toFixed(6)}%` : '—'}
            />
          </div>
        </Panel>

        <Panel title="Proximo ajuste de dificuldade">
          <Gauge
            value={k.difficultyProgressPct ?? 0}
            max={100}
            label="EPOCA ATUAL"
            readout={`${(k.difficultyProgressPct ?? 0).toFixed(0)}%`}
            size={160}
            ticks={10}
          />
          <div className="mt-1 space-y-0.5">
            <KeyValue
              k="Variacao prevista"
              v={
                k.difficultyChangePct !== null
                  ? `${k.difficultyChangePct > 0 ? '+' : ''}${k.difficultyChangePct.toFixed(2)}%`
                  : '—'
              }
              tone={k.difficultyChangePct !== null && k.difficultyChangePct > 0 ? 'warn' : undefined}
            />
            <KeyValue k="Blocos restantes" v={fmtNum(k.difficultyRemainingBlocks ?? 0)} />
            <KeyValue k="Faltam" v={retargetIn ? fmtDuration(retargetIn) : '—'} />
            <KeyValue
              k="Impacto na receita"
              v={
                k.difficultyChangePct !== null
                  ? fmtBrl(t.revenueDayBrl * (100 / (100 + k.difficultyChangePct) - 1), true) + '/dia'
                  : '—'
              }
              tone={k.difficultyChangePct !== null && k.difficultyChangePct > 0 ? 'crit' : undefined}
            />
          </div>
        </Panel>

        <Panel title="Halving">
          <Stat
            label="Faltam"
            value={k.blocksToHalving !== null ? `${fmtNum(k.blocksToHalving)}` : '—'}
            sub="blocos"
            size="lg"
          />
          <div className="mt-2">
            <Meter ratio={k.blocksToHalving !== null ? 1 - k.blocksToHalving / 210000 : 0} segments={24} height={7} />
          </div>
          <div className="mt-2 space-y-0.5">
            <KeyValue k="Estimativa" v={halvingIn ? fmtDuration(halvingIn) : '—'} />
            <KeyValue
              k="Data provavel"
              v={k.halvingDate ? new Date(k.halvingDate).toLocaleDateString('pt-BR') : '—'}
            />
            <KeyValue k="Altura atual" v={fmtNum(k.blockHeight ?? 0)} />
          </div>
        </Panel>
      </div>

      {/* -------------------------------------------------- simulador */}
      <Panel title="Simulador de cenarios" right="ajuste os controles e veja o resultado">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-[0.7rem]">
                <span className="dim">PRECO DO BTC</span>
                <span className="hot">
                  {fmtBrl(simPriceBrl, true)} ({priceMult >= 100 ? '+' : ''}
                  {priceMult - 100}%)
                </span>
              </div>
              <input
                type="range"
                min={20}
                max={300}
                step={5}
                value={priceMult}
                onChange={(e) => setPriceMult(Number(e.target.value))}
                className="mt-2 !p-0 accent-white"
              />
            </div>

            <div className={allFixed ? 'opacity-40' : ''}>
              <div className="flex justify-between text-[0.7rem]">
                <span className="dim">TARIFA DE ENERGIA</span>
                <span className="hot">R$ {tariff.toFixed(3)}/kWh</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.005}
                value={tariff}
                onChange={(e) => setTariffOverride(Number(e.target.value))}
                disabled={allFixed}
                className="mt-2 !p-0"
              />
              {allFixed && (
                <span className="mt-1 block text-[0.6rem] dimmer">
                  Toda a fazenda esta em custo fechado (USD/mes) — a tarifa por kWh nao afeta o resultado.
                </span>
              )}
            </div>

            <div>
              <div className="flex justify-between text-[0.7rem]">
                <span className="dim">DIFICULDADE DA REDE</span>
                <span className={diffMult > 100 ? 'text-warn' : 'hot'}>
                  {diffMult >= 100 ? '+' : ''}
                  {diffMult - 100}%
                </span>
              </div>
              <input
                type="range"
                min={50}
                max={250}
                step={5}
                value={diffMult}
                onChange={(e) => setDiffMult(Number(e.target.value))}
                className="mt-2 !p-0"
              />
            </div>

            <button
              className="term-btn"
              onClick={() => {
                setPriceMult(100);
                setDiffMult(100);
                setTariffOverride(null);
              }}
            >
              restaurar cenario atual
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:col-span-2">
            <Stat label="Receita / dia" value={fmtBrl(simRevenueBrl, true)} sub={`${simRevenueBtc.toFixed(8)} BTC`} size="lg" />
            <Stat label="Energia / dia" value={fmtBrl(simCostBrl, true)} sub={`${fmtNum(t.kwhDay, 0)} kWh`} size="lg" />
            <Stat
              label="Lucro / dia"
              value={fmtBrl(simProfit, true)}
              tone={simProfit < 0 ? 'crit' : 'normal'}
              sub={`margem ${fmtPct(simMargin, 1)}`}
              size="lg"
            />
            <Stat
              label="Lucro / mes"
              value={fmtBrl(simProfit * 30, true)}
              tone={simProfit < 0 ? 'crit' : 'normal'}
              size="lg"
            />
            <div className="col-span-2 space-y-0.5 border-t border-phos/15 pt-2">
              <KeyValue k="Break-even do BTC neste cenario" v={fmtBrl(simBreakeven, true)} />
              <KeyValue
                k="Tarifa maxima suportada"
                v={allFixed ? 'nao se aplica (custo fechado)' : `R$ ${maxTariff.toFixed(3)}/kWh`}
              />
              {t.costDayFixedBrl > 0 && (
                <KeyValue k="Parcela de custo fechado" v={`${fmtBrl(t.costDayFixedBrl, true)}/dia`} />
              )}
              <KeyValue
                k="Sobra por kWh consumido"
                v={`R$ ${(t.kwhDay > 0 ? simProfit / t.kwhDay : 0).toFixed(3)}`}
                tone={simProfit < 0 ? 'crit' : undefined}
              />
              <KeyValue k="Receita por TH/dia" v={`${((simRevenueBtc / Math.max(1, t.hashrate1h)) * 1e8).toFixed(0)} sats`} />
            </div>

            {/* O contrato em dolar faz o custo em satoshis cair quando o BTC sobe. */}
            <div className="col-span-2 border border-phos/20 p-2">
              <div className="panel-title mb-1">Em satoshis · contrato fixo em dolar</div>
              <KeyValue k="Minerado / dia" v={`${fmtNum(simRevenueSats)} sats`} />
              <KeyValue
                k="Energia / dia"
                v={`${fmtNum(simCostSats)} sats`}
                tone={priceMult < 100 ? 'warn' : undefined}
              />
              <KeyValue
                k="Sobra / dia"
                v={`${fmtNum(simProfitSats)} sats`}
                tone={simProfitSats < 0 ? 'crit' : undefined}
              />
              <KeyValue
                k="Producao consumida"
                v={fmtPct(simBurn, 1)}
                tone={simBurn > 100 ? 'crit' : simBurn > 70 ? 'warn' : undefined}
              />
              <p className="mt-1 text-[0.6rem] dimmer">
                Em dolar o custo nao se mexe com o preco ({fmtMoney(simCostUsd, 'USD')}/dia). Subindo o BTC, os mesmos
                dolares custam menos satoshis e a sobra aumenta duas vezes: pela receita em fiat e pelo custo em sats.
              </p>
            </div>
          </div>
        </div>
      </Panel>

      {/* -------------------------------------------------- tabela de cenarios */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Sensibilidade ao preco do BTC" bodyClassName="p-0 overflow-x-auto">
          <table className="term">
            <thead>
              <tr>
                <th>Variacao</th>
                <th>Preco BTC</th>
                <th>Receita/dia</th>
                <th>Lucro/dia</th>
                <th>Margem</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => {
                const price = k.btcBrl * (1 + s / 100);
                const rev = t.revenueDayBtc * price;
                const prof = rev - t.costDayBrl;
                return (
                  <tr key={s} className={s === 0 ? 'bg-phos/10' : ''}>
                    <td className={s === 0 ? 'hot' : 'dim'}>
                      {s > 0 ? '+' : ''}
                      {s}%
                    </td>
                    <td>{fmtBrl(price, true)}</td>
                    <td>{fmtBrl(rev, true)}</td>
                    <td className={prof < 0 ? 'text-crit' : 'hot'}>{fmtBrl(prof, true)}</td>
                    <td className={prof < 0 ? 'text-crit' : ''}>{fmtPct(rev > 0 ? (prof / rev) * 100 : 0, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel
          title={allFixed ? 'Sensibilidade ao custo fechado por maquina' : 'Sensibilidade a tarifa de energia'}
          bodyClassName="p-0 overflow-x-auto"
        >
          <table className="term">
            <thead>
              <tr>
                <th>{allFixed ? 'USD/mes por maquina' : 'Tarifa'}</th>
                <th>Custo/dia</th>
                <th>Lucro/dia</th>
                <th>Lucro/mes</th>
                <th>Margem</th>
              </tr>
            </thead>
            <tbody>
              {(allFixed ? fixedScenarios : tariffScenarios).map((row) => (
                <tr key={row.key} className={row.current ? 'bg-phos/10' : ''}>
                  <td className={row.current ? 'hot' : 'dim'}>{row.label}</td>
                  <td>{fmtBrl(row.cost, true)}</td>
                  <td className={row.profit < 0 ? 'text-crit' : 'hot'}>{fmtBrl(row.profit, true)}</td>
                  <td className={row.profit < 0 ? 'text-crit' : ''}>{fmtBrl(row.profit * 30, true)}</td>
                  <td>{fmtPct(t.revenueDayBrl > 0 ? (row.profit / t.revenueDayBrl) * 100 : 0, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Mempool e taxas">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Rapida" value={`${k.feeFastest ?? '—'}`} sub="sat/vB" />
          <Stat label="30 minutos" value={`${k.feeHalfHour ?? '—'}`} sub="sat/vB" />
          <Stat label="1 hora" value={`${k.feeHour ?? '—'}`} sub="sat/vB" />
          <Stat label="Economica" value={`${k.feeEconomy ?? '—'}`} sub="sat/vB" />
          <Stat label="Transacoes na fila" value={fmtNum(k.mempoolCount ?? 0)} sub="mempool" />
        </div>
        <div className="mt-3 border-t border-phos/15 pt-2">
          <KeyValue k="Sua producao diaria" v={`${(t.revenueDayBtc * 1e8).toFixed(0)} sats`} />
          <KeyValue k="Hashrate da fazenda" v={fmtHash(t.hashrate1h)} />
          <KeyValue k="Hashprice atual" v={`${fmtMoney(t.hashpriceUsd, 'USD')} por PH/dia`} />
        </div>
      </Panel>
    </div>
  );
}
