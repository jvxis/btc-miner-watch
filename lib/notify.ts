import { db } from './db';
import type { Settings } from './types';

/**
 * Avisos no Telegram.
 *
 * Tres cuidados definem se isto e util ou vira ruido ignorado:
 * cada condicao avisa uma vez so, quando comeca, e avisa de novo quando
 * termina — sem o aviso de fim nao da para saber se o problema continua sem
 * abrir o painel; e quando muita coisa cai junto, tudo vai numa mensagem so,
 * porque uma queda geral disparando uma notificacao por maquina ensina o
 * dono a silenciar o bot.
 */

export interface Aviso {
  /** identidade da condicao; enquanto se repetir, nao reenvia */
  id: string;
  texto: string;
  /** texto do aviso de normalizacao; sem ele, a condicao encerra em silencio */
  textoFim?: string;
}

/** Nao ha interruptor separado: configurou, esta ligado. */
export function telegramConfigurado(settings: Settings): boolean {
  return Boolean(settings.telegramToken?.trim() && settings.telegramChatId?.trim());
}

export async function sendTelegram(settings: Settings, texto: string): Promise<{ ok: boolean; erro?: string }> {
  const token = settings.telegramToken?.trim() ?? '';
  const chatId = settings.telegramChatId?.trim() ?? '';
  if (!token || !chatId) return { ok: false, erro: 'token ou chat id em branco' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    return body.ok ? { ok: true } : { ok: false, erro: body.description ?? `HTTP ${res.status}` };
  } catch (e) {
    const err = e as Error;
    return { ok: false, erro: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function abertos(): Map<string, { texto_fim: string | null }> {
  const rows = db()
    .prepare('SELECT alert_id, texto_fim FROM notifications WHERE cleared_at IS NULL')
    .all() as { alert_id: string; texto_fim: string | null }[];
  return new Map(rows.map((r) => [r.alert_id, { texto_fim: r.texto_fim }]));
}

/** Ids de condicoes ainda abertas, para quem precisa decidir se reabre ou nao. */
export function avisosAbertos(): Set<string> {
  return new Set(abertos().keys());
}

/** O Telegram corta em 4096 caracteres; sobra folga para o cabecalho. */
const LIMITE = 3500;

/**
 * Junta varios textos numa mensagem so, quebrando em lotes que caibam.
 * Cada lote leva junto os ids que representa, para so gravar o que chegou.
 */
function agrupar(itens: { id: string; texto: string }[]): { ids: string[]; texto: string }[] {
  if (itens.length === 1) return [{ ids: [itens[0].id], texto: itens[0].texto }];

  const lotes: { ids: string[]; texto: string }[] = [];
  let ids: string[] = [];
  let partes: string[] = [];
  let tamanho = 0;

  for (const it of itens) {
    if (partes.length > 0 && tamanho + it.texto.length > LIMITE) {
      lotes.push({ ids, texto: partes.join('\n\n') });
      ids = [];
      partes = [];
      tamanho = 0;
    }
    ids.push(it.id);
    partes.push(it.texto);
    tamanho += it.texto.length + 2;
  }
  if (partes.length > 0) lotes.push({ ids, texto: partes.join('\n\n') });

  return lotes.map((l, i) => ({
    ids: l.ids,
    texto: `⚠️ ${l.ids.length} avisos${lotes.length > 1 ? ` (${i + 1}/${lotes.length})` : ''}\n\n${l.texto}`,
  }));
}

/**
 * Envia o que comecou e o que terminou desde a ultima passagem.
 * Silencioso quando o Telegram nao esta configurado — nada de acumular fila.
 */
export async function despacharAvisos(settings: Settings, atuais: Aviso[]): Promise<void> {
  if (!telegramConfigurado(settings)) return;

  const conn = db();
  const jaAbertos = abertos();
  const agoraIds = new Set(atuais.map((a) => a.id));

  const marcarEnviado = conn.prepare(
    `INSERT INTO notifications (alert_id, texto_fim, sent_at, cleared_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(alert_id) DO UPDATE SET texto_fim = excluded.texto_fim,
       sent_at = excluded.sent_at, cleared_at = NULL`,
  );

  // --- o que comecou
  const novos = atuais.filter((a) => !jaAbertos.has(a.id));
  const fimPorId = new Map(novos.map((a) => [a.id, a.textoFim ?? null]));
  for (const lote of agrupar(novos)) {
    const r = await sendTelegram(settings, lote.texto);
    if (!r.ok) {
      console.error('[miner-watch] telegram falhou:', r.erro);
      continue; // sem gravar, tenta de novo no proximo ciclo
    }
    const agora = Date.now();
    for (const id of lote.ids) marcarEnviado.run(id, fimPorId.get(id) ?? null, agora);
  }

  // --- o que terminou
  const encerrados = [...jaAbertos].filter(([id]) => !agoraIds.has(id));
  const comTexto = encerrados
    .filter(([, info]) => info.texto_fim)
    .map(([id, info]) => ({ id, texto: info.texto_fim as string }));

  for (const lote of agrupar(comTexto)) {
    const r = await sendTelegram(settings, lote.texto);
    if (!r.ok) console.error('[miner-watch] telegram falhou no encerramento:', r.erro);
  }

  // Encerra mesmo se o envio falhou: repetir o "voltou ao normal" mais tarde
  // seria pior que perde-lo, porque chegaria fora de hora.
  const fecha = conn.prepare('UPDATE notifications SET cleared_at = ? WHERE alert_id = ?');
  const agora = Date.now();
  for (const [id] of encerrados) fecha.run(agora, id);
}
