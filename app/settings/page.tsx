'use client';

import { useState } from 'react';
import { KeyValue, Panel, Stat } from '@/components/ui';
import { useEvents, useNow, useOverview, useSettings } from '@/lib/client';
import { fmtBrl, fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtUsd } from '@/lib/format';
import type { CostMode, MinerConfig, Settings } from '@/lib/types';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="panel-title">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[0.6rem] dimmer">{hint}</span>}
    </label>
  );
}

export default function SettingsPage() {
  const agora = useNow() || Date.parse('2026-01-01');
  const { data: loaded, mutate } = useSettings();
  const { data: overview, mutate: mutateOverview } = useOverview();
  const { data: diag } = useEvents();
  /** Rascunho local: null significa "igual ao que esta gravado no servidor". */
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [testando, setTestando] = useState(false);
  const [testeMsg, setTesteMsg] = useState('');

  const s = draft ?? loaded ?? null;
  if (!s) return <p className="dim caret py-8">CARREGANDO CONFIGURACOES</p>;
  const setS = setDraft;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });

  const setMiner = (worker: string, patch: Partial<MinerConfig>) =>
    setS({ ...s, miners: s.miners.map((m) => (m.worker === worker ? { ...m, ...patch } : m)) });

  const applyToAll = (patch: Partial<MinerConfig>) =>
    setS({ ...s, miners: s.miners.map((m) => ({ ...m, ...patch })) });

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'falha ao gravar');
      await mutate();
      await mutateOverview();
      setDraft(null); // volta a espelhar o que esta gravado
      setMsg('CONFIGURACOES GRAVADAS');
    } catch (e) {
      setMsg(`ERRO: ${(e as Error).message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const telegramPronto = Boolean(s.telegramToken.trim() && s.telegramChatId.trim());

  const enabled = s.miners.filter((m) => m.enabled);
  const totalWatts = enabled.reduce((a, m) => a + m.watts, 0);
  const totalNominal = enabled.reduce((a, m) => a + m.nominalTh, 0);
  const kwhDay = (totalWatts / 1000) * 24;
  const tariffEff = s.tariffBrl * (1 + s.tariffSurchargePct / 100);
  const usdBrl = overview?.market.usdBrl ?? 0;

  /** Maquina ainda dentro da janela de cortesia.
   *  Declarada antes de quem a usa: `energyDay` invoca na hora, e um `const`
   *  referenciado antes da propria linha lanca em tempo de execucao. */
  const cortesiaAtiva = (m: MinerConfig) =>
    m.courtesyDays > 0 && m.firstHashAt !== null && agora < m.firstHashAt + m.courtesyDays * 86400000;

  /** Custo diario de uma maquina, em BRL, no modelo que valer para ela. */
  const minerCostDayBrl = (m: MinerConfig): number => {
    const mode: CostMode = m.costMode === 'inherit' ? s.costModel : m.costMode;
    // Em cortesia a maquina roda de graca.
    if (mode === 'fixedUsd' && cortesiaAtiva(m)) return 0;
    if (mode === 'fixedUsd') return ((m.fixedMonthlyUsd ?? s.fixedMonthlyUsdPerMiner) / 30) * usdBrl;
    const tf = (m.tariffBrl ?? s.tariffBrl) * (1 + s.tariffSurchargePct / 100);
    return (m.watts / 1000) * 24 * tf;
  };

  const energyDay = enabled.reduce((a, m) => a + minerCostDayBrl(m), 0);
  const costDay = energyDay + s.fixedMonthlyCostBrl / 30;

  const isFixed = (m: MinerConfig) => (m.costMode === 'inherit' ? s.costModel : m.costMode) === 'fixedUsd';
  const fixedMiners = enabled.filter(isFixed);
  const fixedCount = fixedMiners.length;
  /** Soma dos contratos fechados, em USD por mes. */
  const contractedUsdMonth = fixedMiners
    .filter((m) => !cortesiaAtiva(m))
    .reduce((a, m) => a + (m.fixedMonthlyUsd ?? s.fixedMonthlyUsdPerMiner), 0);
  const customCount = enabled.filter((m) => m.fixedMonthlyUsd !== null).length;
  const emCortesia = fixedMiners.filter(cortesiaAtiva).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl hot">CONFIGURACOES</h1>
        <span className="dim text-[0.7rem]">parametros de energia, alertas e maquinas</span>
        <div className="ml-auto flex items-center gap-3">
          {msg && <span className={msg.startsWith('ERRO') ? 'text-crit' : 'hot'}>{msg}</span>}
          <button className="term-btn" onClick={save} disabled={saving}>
            {saving ? 'gravando…' : 'gravar alteracoes'}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------- previa */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <Stat label="Potencia configurada" value={`${(totalWatts / 1000).toFixed(2)} kW`} sub={`${s.miners.filter((m) => m.enabled).length} maquinas ativas`} />
        </Panel>
        <Panel>
          <Stat label="Consumo diario" value={`${fmtNum(kwhDay, 0)} kWh`} sub={`${fmtNum(kwhDay * 30, 0)} kWh/mes`} />
        </Panel>
        <Panel>
          <Stat label="Custo diario" value={fmtBrl(costDay, true)} sub={`${fmtBrl(costDay * 30, true)}/mes`} />
        </Panel>
        <Panel>
          <Stat
            label="Lucro estimado/dia"
            value={fmtBrl((overview?.totals.revenueDayBrl ?? 0) - costDay, true)}
            tone={(overview?.totals.revenueDayBrl ?? 0) - costDay < 0 ? 'crit' : 'normal'}
            sub={`receita atual ${fmtBrl(overview?.totals.revenueDayBrl ?? 0, true)}`}
          />
        </Panel>
      </div>

      {/* ---------------------------------------------------- energia */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Custo de energia" right={s.costModel === 'fixedUsd' ? 'valor fechado' : 'por consumo'}>
          <Field
            label="Modelo de custo padrao"
            hint="vale para todas as maquinas que estiverem em MODO = global na tabela abaixo"
          >
            <select value={s.costModel} onChange={(e) => set('costModel', e.target.value as CostMode)}>
              <option value="tariff">Consumo medido × tarifa por kWh</option>
              <option value="fixedUsd">Valor fechado por maquina (USD/mes)</option>
            </select>
          </Field>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {s.costModel === 'fixedUsd' ? (
              <Field
                label="Custo fechado por maquina (USD/mes)"
                hint="o que voce paga por maquina, independente do consumo"
              >
                <input
                  type="number"
                  step="1"
                  value={s.fixedMonthlyUsdPerMiner}
                  onChange={(e) => set('fixedMonthlyUsdPerMiner', Number(e.target.value))}
                />
              </Field>
            ) : (
              <Field label="Tarifa (BRL por kWh)" hint="valor da sua conta de luz dividido pelos kWh consumidos">
                <input
                  type="number"
                  step="0.001"
                  value={s.tariffBrl}
                  onChange={(e) => set('tariffBrl', Number(e.target.value))}
                />
              </Field>
            )}
            <Field
              label={s.costModel === 'fixedUsd' ? 'Tarifa de referencia (BRL/kWh)' : 'Acrescimo (%)'}
              hint={
                s.costModel === 'fixedUsd'
                  ? 'usada apenas pelas maquinas que voce marcar individualmente como tarifa'
                  : 'bandeira tarifaria, ICMS, PIS/COFINS, iluminacao publica'
              }
            >
              {s.costModel === 'fixedUsd' ? (
                <input
                  type="number"
                  step="0.001"
                  value={s.tariffBrl}
                  onChange={(e) => set('tariffBrl', Number(e.target.value))}
                />
              ) : (
                <input
                  type="number"
                  step="0.5"
                  value={s.tariffSurchargePct}
                  onChange={(e) => set('tariffSurchargePct', Number(e.target.value))}
                />
              )}
            </Field>
            <Field label="Custo fixo mensal (BRL)" hint="aluguel do galpao, internet, manutencao — rateado por maquina">
              <input
                type="number"
                step="10"
                value={s.fixedMonthlyCostBrl}
                onChange={(e) => set('fixedMonthlyCostBrl', Number(e.target.value))}
              />
            </Field>
            <Field label="Moeda principal" hint="usada nos cartoes do painel">
              <select
                value={s.primaryCurrency}
                onChange={(e) => set('primaryCurrency', e.target.value as 'BRL' | 'USD')}
              >
                <option value="BRL">BRL — Real</option>
                <option value="USD">USD — Dolar</option>
              </select>
            </Field>
          </div>

          <div className="mt-3 border-t border-phos/15 pt-2">
            {s.costModel === 'fixedUsd' ? (
              <KeyValue
                k="Cambio aplicado"
                v={usdBrl > 0 ? `USD 1,00 = R$ ${usdBrl.toFixed(3)}` : 'aguardando cotacao'}
              />
            ) : (
              <KeyValue k="Tarifa efetiva" v={`R$ ${tariffEff.toFixed(4)}/kWh`} />
            )}
            <KeyValue k="Maquinas em valor fechado" v={`${fixedCount} de ${enabled.length}`} />
            {fixedCount > 0 && (
              <>
                <KeyValue k="Total contratado" v={`${fmtUsd(contractedUsdMonth, true)}/mes`} />
                <KeyValue
                  k="Media por maquina"
                  v={`${fmtUsd(contractedUsdMonth / fixedCount, true)}/mes`}
                  />
                <KeyValue
                  k="Com valor proprio"
                  v={`${customCount} maquina(s)${customCount < fixedCount ? ` · ${fixedCount - customCount} no valor global` : ''}`}
                />
              </>
            )}
            <KeyValue k="Energia da fazenda/mes" v={fmtBrl(energyDay * 30, true)} />
            <KeyValue k="Custo por maquina/dia" v={fmtBrl(enabled.length ? costDay / enabled.length : 0)} />
            <KeyValue
              k="Break-even do BTC"
              v={fmtMoney(
                overview && overview.totals.revenueDayBtc > 0 ? costDay / overview.totals.revenueDayBtc : 0,
                'BRL',
                true,
              )}
            />
          </div>
        </Panel>

        <Panel title="Alertas">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Hashrate minimo (% do nominal)" hint="abaixo disso a maquina aparece como degradada">
              <input
                type="number"
                step="1"
                value={s.alertHashratePct}
                onChange={(e) => set('alertHashratePct', Number(e.target.value))}
              />
            </Field>
            <Field label="Rejeicao maxima (%)" hint="reject rate acima disso gera aviso">
              <input
                type="number"
                step="0.1"
                value={s.alertRejectPct}
                onChange={(e) => set('alertRejectPct', Number(e.target.value))}
              />
            </Field>
            <Field label="Minutos sem share = offline" hint="tempo sem enviar share para considerar a maquina parada">
              <input
                type="number"
                step="1"
                value={s.alertOfflineMinutes}
                onChange={(e) => set('alertOfflineMinutes', Number(e.target.value))}
              />
            </Field>
            <Field
              label="Minutos degradada = aviso prolongado"
              hint="abaixo disso a queda e tratada como passageira e nao promove o alerta"
            >
              <input
                type="number"
                step="5"
                min="5"
                value={s.alertDegradedMinutes}
                onChange={(e) => set('alertDegradedMinutes', Number(e.target.value))}
              />
            </Field>
            <Field
              label="Eficiencia de referencia (J/TH)"
              hint={
                s.miners.length > 0
                  ? `so alimenta o botao "calcular watts por J/TH" — daria ${fmtNum(
                      Math.round(s.miners[0].nominalTh * s.referenceJPerTh),
                    )} W por maquina de ${s.miners[0].nominalTh} TH/s`
                  : 'so alimenta o botao "calcular watts por J/TH"'
              }
            >
              <input
                type="number"
                step="0.1"
                value={s.referenceJPerTh}
                onChange={(e) => set('referenceJPerTh', Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="mt-3 border-t border-phos/15 pt-2 text-[0.66rem] dim">
            O coletor local grava um ponto por minuto. Quanto mais tempo o app fica rodando, mais precisas ficam as
            medias de 24h, o uptime e os graficos por maquina.
          </div>
        </Panel>
      </div>

      {/* ---------------------------------------------------- telegram */}
      <Panel
        title="Avisos no Telegram"
        right={
          telegramPronto ? (
            <span className="hot">■ ativo</span>
          ) : (
            <span className="dim">□ preencha os dois campos</span>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Token do bot" hint="obtido no @BotFather">
            <input
              type="password"
              value={s.telegramToken}
              onChange={(e) => set('telegramToken', e.target.value)}
              placeholder="123456:ABC-DEF..."
              autoComplete="off"
            />
          </Field>
          <Field label="Chat ID" hint="seu ID pessoal ou o do grupo; grupo comeca com sinal negativo">
            <input
              value={s.telegramChatId}
              onChange={(e) => set('telegramChatId', e.target.value)}
              placeholder="-1001234567890"
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-phos/15 pt-2">
          <button
            className="term-btn"
            disabled={testando || !telegramPronto}
            onClick={async () => {
              setTestando(true);
              setTesteMsg('');
              try {
                await save(); // o teste usa a configuracao do servidor, nao a da tela
                const res = await fetch('/api/telegram-test', { method: 'POST' });
                const body = await res.json();
                setTesteMsg(res.ok ? 'MENSAGEM ENVIADA' : `ERRO: ${body.erro}`);
              } catch (e) {
                setTesteMsg(`ERRO: ${(e as Error).message}`);
              } finally {
                setTestando(false);
                setTimeout(() => setTesteMsg(''), 6000);
              }
            }}
          >
            {testando ? 'enviando…' : 'enviar teste'}
          </button>
          {testeMsg && <span className={testeMsg.startsWith('ERRO') ? 'text-crit' : 'hot'}>{testeMsg}</span>}
          <span className="ml-auto text-[0.62rem] dimmer">
            o teste grava as configuracoes antes de enviar
          </span>
        </div>

        <div className="mt-2 space-y-1 text-[0.62rem] dimmer">
          <p>
            Avisa em: <span className="dim">maquina offline</span>,{' '}
            <span className="dim">fazenda inteira parada</span>,{' '}
            <span className="dim">falha de contato com a pool</span> e{' '}
            <span className="dim">degradacao acima de {s.alertDegradedMinutes} minutos</span>.
          </p>
          <p>
            Cada condicao avisa uma vez quando comeca e outra quando normaliza — nao repete a cada leitura. Queda
            passageira nao gera mensagem, e quando muita coisa cai junto tudo vai numa mensagem so.
          </p>
          <p>
            Nao ha interruptor separado: com os dois campos preenchidos os avisos estao ligados. Para silenciar, apague
            o chat id.
          </p>
        </div>
      </Panel>

      {/* ---------------------------------------------------- maquinas */}
      <Panel
        title={`Maquinas (${s.miners.length})`}
        right={
          <div className="flex flex-wrap gap-1">
            <button
              className="term-btn !py-[2px] !px-2"
              onClick={() => {
                const v = prompt('Hashrate nominal (TH/s) para todas as maquinas:', String(s.miners[0]?.nominalTh ?? 191));
                if (v) applyToAll({ nominalTh: Number(v) });
              }}
            >
              nominal p/ todas
            </button>
            <button
              className="term-btn !py-[2px] !px-2"
              onClick={() => {
                const v = prompt('Consumo (W) para todas as maquinas:', String(s.miners[0]?.watts ?? 4107));
                if (v) applyToAll({ watts: Number(v) });
              }}
            >
              watts p/ todas
            </button>
            <button
              className="term-btn !py-[2px] !px-2"
              onClick={() =>
                setS({
                  ...s,
                  miners: s.miners.map((m) => ({ ...m, watts: Math.round(m.nominalTh * s.referenceJPerTh) })),
                })
              }
            >
              calcular watts por J/TH
            </button>
            <button
              className="term-btn !py-[2px] !px-2"
              onClick={() => {
                const v = prompt(
                  'Custo fechado em USD/mes para todas as maquinas (deixe vazio para voltar ao global):',
                  String(s.miners[0]?.fixedMonthlyUsd ?? s.fixedMonthlyUsdPerMiner),
                );
                if (v === null) return;
                applyToAll(
                  v === ''
                    ? { costMode: 'inherit', fixedMonthlyUsd: null }
                    : { costMode: 'fixedUsd', fixedMonthlyUsd: Number(v) },
                );
              }}
            >
              custo fixo USD p/ todas
            </button>
            <button className="term-btn !py-[2px] !px-2" onClick={() => applyToAll({ costMode: 'inherit' })}>
              voltar todas ao global
            </button>
          </div>
        }
        bodyClassName="p-0 overflow-x-auto"
      >
        <table className="term">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Apelido</th>
              <th>Nominal TH/s</th>
              <th>Watts</th>
              <th>J/TH</th>
              <th>Modo de custo</th>
              <th>Fixo USD/mes</th>
              <th>Cortesia</th>
              <th>Tarifa propria</th>
              <th>Local</th>
              <th>Custo/dia</th>
              <th>Ativa</th>
            </tr>
          </thead>
          <tbody>
            {s.miners.map((m) => {
              const mode: CostMode = m.costMode === 'inherit' ? s.costModel : m.costMode;
              return (
                <tr key={m.worker}>
                  <td className="dim">{m.worker}</td>
                  <td>
                    <input
                      value={m.label}
                      onChange={(e) => setMiner(m.worker, { label: e.target.value })}
                      className="!w-[140px]"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="1"
                      value={m.nominalTh}
                      onChange={(e) => setMiner(m.worker, { nominalTh: Number(e.target.value) })}
                      className="!w-[90px]"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="10"
                      value={m.watts}
                      onChange={(e) => setMiner(m.worker, { watts: Number(e.target.value) })}
                      className="!w-[90px]"
                    />
                  </td>
                  <td className="dim">{m.nominalTh > 0 ? (m.watts / m.nominalTh).toFixed(2) : '—'}</td>
                  <td>
                    <select
                      value={m.costMode}
                      onChange={(e) => setMiner(m.worker, { costMode: e.target.value as MinerConfig['costMode'] })}
                      className="!w-[130px] !text-[0.7rem]"
                    >
                      <option value="inherit">
                        global ({s.costModel === 'fixedUsd' ? 'fixo USD' : 'tarifa'})
                      </option>
                      <option value="fixedUsd">fixo USD/mes</option>
                      <option value="tariff">tarifa por kWh</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      step="1"
                      placeholder={String(s.fixedMonthlyUsdPerMiner)}
                      value={m.fixedMonthlyUsd ?? ''}
                      onChange={(e) =>
                        setMiner(m.worker, {
                          fixedMonthlyUsd: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      disabled={mode !== 'fixedUsd'}
                      className={`!w-[90px] ${mode !== 'fixedUsd' ? 'opacity-30' : ''}`}
                    />
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        step="1"
                        min="0"
                        value={m.courtesyDays}
                        onChange={(e) => setMiner(m.worker, { courtesyDays: Number(e.target.value) })}
                        disabled={mode !== 'fixedUsd'}
                        className={`!w-[62px] ${mode !== 'fixedUsd' ? 'opacity-30' : ''}`}
                        title="Dias sem cobranca a partir do primeiro hash"
                      />
                      <span className="text-[0.6rem] dimmer">d</span>
                      {m.courtesyDays > 0 && (
                        <span
                          className={`text-[0.6rem] ${cortesiaAtiva(m) ? 'text-warn' : 'dimmer'}`}
                          title={
                            m.firstHashAt
                              ? `Primeiro hash em ${fmtDateTime(m.firstHashAt)}`
                              : 'Aguardando o primeiro hash para comecar a contar'
                          }
                        >
                          {m.firstHashAt === null
                            ? 'aguardando'
                            : cortesiaAtiva(m)
                              ? `ate ${fmtDate(m.firstHashAt + m.courtesyDays * 86400000)}`
                              : 'encerrada'}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.001"
                      placeholder="global"
                      value={m.tariffBrl ?? ''}
                      onChange={(e) =>
                        setMiner(m.worker, { tariffBrl: e.target.value === '' ? null : Number(e.target.value) })
                      }
                      disabled={mode !== 'tariff'}
                      className={`!w-[90px] ${mode !== 'tariff' ? 'opacity-30' : ''}`}
                    />
                  </td>
                  <td>
                    <input
                      value={m.location}
                      onChange={(e) => setMiner(m.worker, { location: e.target.value })}
                      placeholder="rack / sala"
                      className="!w-[120px]"
                    />
                  </td>
                  <td className="hot">{fmtBrl(minerCostDayBrl(m))}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      onChange={(e) => setMiner(m.worker, { enabled: e.target.checked })}
                      className="!w-auto"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="dim">
                TOTAL
              </td>
              <td className="hot">{totalNominal}</td>
              <td className="hot">{fmtNum(totalWatts)}</td>
              <td className="dim">{fixedCount > 0 ? `${fixedCount} fixo` : 'tarifa'}</td>
              <td className="hot">{fixedCount > 0 ? fmtUsd(contractedUsdMonth, true) : '—'}</td>
              <td className="dim">
                {emCortesia > 0 ? `${emCortesia} em cortesia` : ''}
              </td>
              <td colSpan={3} className="dim">
                {fixedCount > 0 ? `${fmtUsd(contractedUsdMonth / 30, true)}/dia contratados` : ''}
              </td>
              <td className="hot">{fmtBrl(energyDay, true)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <p className="p-3 text-[0.62rem] dimmer">
          Cada maquina pode ter o seu proprio valor: basta digitar em FIXO USD/MES. Deixando em branco, a maquina segue
          o valor global ({fmtUsd(s.fixedMonthlyUsdPerMiner, true)}/mes). Use MODO DE CUSTO apenas se alguma maquina for
          cobrada por consumo em vez de contrato fechado.
        </p>
      </Panel>

      <div className="flex justify-end">
        <button className="term-btn" onClick={save} disabled={saving}>
          {saving ? 'gravando…' : 'gravar alteracoes'}
        </button>
      </div>

      {/* ---------------------------------------------------- diagnostico */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Diagnostico do coletor">
          <KeyValue k="Estado" v={diag?.poller?.ok ? 'OPERANDO' : 'COM ERRO'} tone={diag?.poller?.ok ? undefined : 'crit'} />
          <KeyValue k="Mensagem" v={diag?.poller?.message ?? '—'} />
          <KeyValue
            k="Ultima leitura com sucesso"
            v={diag?.poller?.lastSuccess ? fmtDateTime(diag.poller.lastSuccess) : '—'}
          />
          <KeyValue k="Erros consecutivos" v={String(diag?.poller?.consecutiveErrors ?? 0)} />
          <KeyValue k="Amostras no banco" v={fmtNum(diag?.samples ?? 0)} />
          <div className="mt-3 border-t border-phos/15 pt-2 text-[0.62rem] dimmer">
            Fonte: ViaBTC Pool API · o IP desta maquina precisa estar no whitelist da pagina de configuracoes de
            mineracao da ViaBTC. Ao migrar para uma VPS, troque o IP la e reinicie o app.
          </div>
        </Panel>

        <Panel title="Log de eventos" bodyClassName="p-0 max-h-[360px] overflow-auto">
          <table className="term">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Maquina</th>
                <th>Evento</th>
              </tr>
            </thead>
            <tbody>
              {(diag?.events ?? []).map((e: { id: number; ts: number; worker: string | null; level: string; detail: string }) => (
                <tr key={e.id}>
                  <td className="dim">{fmtDateTime(e.ts)}</td>
                  <td className={e.level === 'critical' ? 'text-crit' : e.level === 'warning' ? 'text-warn' : ''}>
                    {e.worker ?? 'SISTEMA'}
                  </td>
                  <td className="dim whitespace-normal">{e.detail}</td>
                </tr>
              ))}
              {(diag?.events ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="dim">
                    Nenhum evento registrado ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
