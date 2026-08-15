import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * Banco local em SQLite (modulo nativo do Node 24, sem dependencia externa).
 * Ele existe porque a API da pool so entrega valores confiaveis de 10min/1h;
 * as medias de 24h por maquina vem inconsistentes. Guardando um snapshot por
 * minuto conseguimos medias, uptime, quedas e graficos de alta resolucao.
 */

const globalRef = globalThis as unknown as { __minerWatchDb?: DatabaseSync };

function resolveDbPath(): string {
  const raw = process.env.DB_PATH || 'data/miner-watch.db';
  return isAbsolute(raw) ? raw : join(process.cwd(), raw);
}

export function db(): DatabaseSync {
  if (globalRef.__minerWatchDb) return globalRef.__minerWatchDb;

  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const conn = new DatabaseSync(path);

  conn.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS snapshots (
      ts           INTEGER NOT NULL,
      worker       TEXT    NOT NULL,
      worker_id    INTEGER,
      hashrate_10m REAL    NOT NULL,
      hashrate_1h  REAL    NOT NULL,
      reject       REAL    NOT NULL,
      status       TEXT    NOT NULL,
      last_active  INTEGER,
      PRIMARY KEY (ts, worker)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_worker_ts ON snapshots(worker, ts);
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);

    CREATE TABLE IF NOT EXISTS fleet_snapshots (
      ts           INTEGER PRIMARY KEY,
      hashrate_10m REAL NOT NULL,
      hashrate_1h  REAL NOT NULL,
      active       INTEGER NOT NULL,
      inactive     INTEGER NOT NULL,
      reject       REAL NOT NULL,
      btc_usd      REAL,
      btc_brl      REAL
    );

    CREATE TABLE IF NOT EXISTS profit_days (
      date   TEXT PRIMARY KEY,
      total  REAL NOT NULL,
      pps    REAL NOT NULL,
      pplns  REAL NOT NULL,
      solo   REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY,
      amount      REAL NOT NULL,
      address     TEXT,
      tx          TEXT,
      create_time INTEGER NOT NULL
    );

    -- Conta de energia efetivamente paga, em satoshis, por mes de competencia.
    CREATE TABLE IF NOT EXISTS energy_bills (
      month    TEXT PRIMARY KEY,   -- 'YYYY-MM'
      sats     INTEGER NOT NULL,
      paid_at  INTEGER,            -- quando foi pago, opcional
      note     TEXT NOT NULL DEFAULT '',
      updated  INTEGER NOT NULL
    );

    -- Serie de hashrate da conta importada da pool, usada para enxergar quedas
    -- anteriores ao inicio da nossa coleta. 'min' = pontos de 10 minutos.
    CREATE TABLE IF NOT EXISTS pool_chart (
      ts       INTEGER NOT NULL,
      interval TEXT    NOT NULL,
      hashrate REAL    NOT NULL,
      reject   REAL,
      PRIMARY KEY (ts, interval)
    );
    CREATE INDEX IF NOT EXISTS idx_pool_chart ON pool_chart(interval, ts);

    -- Consolidado mensal de indisponibilidade. Os snapshots sao podados depois
    -- de 45 dias; sem isto, o historico de paradas de uma competencia fechada
    -- desapareceria justamente quando fosse preciso para cobrar o credito.
    CREATE TABLE IF NOT EXISTS downtime_monthly (
      month       TEXT    NOT NULL,
      worker      TEXT    NOT NULL,
      down_ms     INTEGER NOT NULL,
      observed_ms INTEGER NOT NULL,
      updated     INTEGER NOT NULL,
      PRIMARY KEY (month, worker)
    );

    -- Cada queda total da fazenda, com inicio e fim. Guardado para o relatorio
    -- de negociacao sobreviver a poda dos snapshots.
    CREATE TABLE IF NOT EXISTS outage_events (
      from_ts INTEGER PRIMARY KEY,
      to_ts   INTEGER NOT NULL,
      month   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outage_events_month ON outage_events(month);

    -- Paradas de cada maquina, para o relatorio distinguir a queda geral da
    -- maquina que ficou fora sozinha.
    CREATE TABLE IF NOT EXISTS miner_outage_events (
      worker  TEXT    NOT NULL,
      from_ts INTEGER NOT NULL,
      to_ts   INTEGER NOT NULL,
      month   TEXT    NOT NULL,
      PRIMARY KEY (worker, from_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_miner_outage_month ON miner_outage_events(month);

    CREATE TABLE IF NOT EXISTS outage_monthly (
      month          TEXT PRIMARY KEY,
      full_outage_ms INTEGER NOT NULL,
      observed_from  INTEGER,
      updated        INTEGER NOT NULL
    );

    -- Desde quando cada maquina esta degradada. Persistido para o alerta de
    -- degradacao prolongada nao zerar quando o app reinicia.
    CREATE TABLE IF NOT EXISTS miner_health (
      worker         TEXT PRIMARY KEY,
      degraded_since INTEGER
    );

    -- Avisos ja enviados. Sem isto, cada ciclo do coletor reenviaria a mesma
    -- condicao e o canal viraria ruido.
    CREATE TABLE IF NOT EXISTS notifications (
      alert_id   TEXT PRIMARY KEY,
      texto_fim  TEXT,
      sent_at    INTEGER NOT NULL,
      cleared_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      ts    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      worker TEXT,
      level  TEXT NOT NULL,
      kind   TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  `);

  // Migracao: producao informada a mao, para meses que nenhuma fonte cobre.
  const cols = conn.prepare('PRAGMA table_info(energy_bills)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'mined_manual')) {
    conn.exec('ALTER TABLE energy_bills ADD COLUMN mined_manual INTEGER');
  }
  // Valor da fatura em dolar: o cobrador fatura em USD e o pagamento sai em
  // satoshis, entao os dois precisam conviver na mesma competencia.
  if (!cols.some((c) => c.name === 'invoice_usd')) {
    conn.exec('ALTER TABLE energy_bills ADD COLUMN invoice_usd REAL');
  }
  // O cobrador fatura adiantado e abate as paradas na fatura seguinte, entao a
  // competencia que gera o credito nao e a que o recebe. Registramos o abatimento
  // na fatura que o absorveu e de qual competencia ele veio.
  if (!cols.some((c) => c.name === 'credit_applied_usd')) {
    conn.exec('ALTER TABLE energy_bills ADD COLUMN credit_applied_usd REAL');
    conn.exec('ALTER TABLE energy_bills ADD COLUMN credit_applied_month TEXT');
  }

  globalRef.__minerWatchDb = conn;
  return conn;
}

// ------------------------------------------------------------------ chave/valor

export function kvGet<T>(key: string): { value: T; ts: number } | null {
  const row = db().prepare('SELECT value, ts FROM kv WHERE key = ?').get(key) as
    | { value: string; ts: number }
    | undefined;
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, ts: row.ts };
  } catch {
    return null;
  }
}

export function kvSet(key: string, value: unknown): void {
  db()
    .prepare('INSERT INTO kv (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts')
    .run(key, JSON.stringify(value), Date.now());
}

// ------------------------------------------------------------------ escrita

export interface SnapshotRow {
  worker: string;
  workerId: number;
  h10m: number;
  h1h: number;
  reject: number;
  status: string;
  lastActive: number;
}

export function writeSnapshots(ts: number, rows: SnapshotRow[]): void {
  const conn = db();
  const stmt = conn.prepare(
    `INSERT INTO snapshots (ts, worker, worker_id, hashrate_10m, hashrate_1h, reject, status, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ts, worker) DO UPDATE SET
       hashrate_10m = excluded.hashrate_10m,
       hashrate_1h  = excluded.hashrate_1h,
       reject       = excluded.reject,
       status       = excluded.status,
       last_active  = excluded.last_active`,
  );
  conn.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(ts, r.worker, r.workerId, r.h10m, r.h1h, r.reject, r.status, r.lastActive);
    }
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

export function writeFleetSnapshot(
  ts: number,
  v: { h10m: number; h1h: number; active: number; inactive: number; reject: number; btcUsd?: number; btcBrl?: number },
): void {
  db()
    .prepare(
      `INSERT INTO fleet_snapshots (ts, hashrate_10m, hashrate_1h, active, inactive, reject, btc_usd, btc_brl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ts) DO UPDATE SET hashrate_10m = excluded.hashrate_10m, hashrate_1h = excluded.hashrate_1h,
         active = excluded.active, inactive = excluded.inactive, reject = excluded.reject,
         btc_usd = excluded.btc_usd, btc_brl = excluded.btc_brl`,
    )
    .run(ts, v.h10m, v.h1h, v.active, v.inactive, v.reject, v.btcUsd ?? null, v.btcBrl ?? null);
}

export function upsertProfitDays(days: { date: string; total: number; pps: number; pplns: number; solo: number }[]): void {
  const stmt = db().prepare(
    `INSERT INTO profit_days (date, total, pps, pplns, solo) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET total = excluded.total, pps = excluded.pps,
       pplns = excluded.pplns, solo = excluded.solo`,
  );
  for (const d of days) stmt.run(d.date, d.total, d.pps, d.pplns, d.solo);
}

export function upsertPayments(rows: { id: number; amount: number; address: string; tx: string; create_time: number }[]): void {
  const stmt = db().prepare(
    `INSERT INTO payments (id, amount, address, tx, create_time) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const r of rows) stmt.run(r.id, r.amount, r.address, r.tx, r.create_time);
}

export function logEvent(level: string, kind: string, worker: string | null, detail: string): void {
  db().prepare('INSERT INTO events (ts, worker, level, kind, detail) VALUES (?, ?, ?, ?, ?)').run(
    Date.now(),
    worker,
    level,
    kind,
    detail,
  );
}

// ------------------------------------------------------------------ leitura

/** Media do hashrate 10min por maquina numa janela (horas), em TH/s. */
export function avgHashrateByWorker(hours: number): Map<string, { avg: number; samples: number; online: number }> {
  const since = Date.now() - hours * 3600_000;
  const rows = db()
    .prepare(
      `SELECT worker,
              AVG(hashrate_10m) AS avg,
              COUNT(*) AS samples,
              SUM(CASE WHEN hashrate_10m > 0 THEN 1 ELSE 0 END) AS online
       FROM snapshots WHERE ts >= ? GROUP BY worker`,
    )
    .all(since) as { worker: string; avg: number; samples: number; online: number }[];
  return new Map(rows.map((r) => [r.worker, { avg: r.avg, samples: r.samples, online: r.online }]));
}

/** Serie temporal por maquina, agrupada em buckets de N minutos. */
export function workerSeries(worker: string, hours: number, bucketMinutes = 10): { t: number; h: number; reject: number }[] {
  const since = Date.now() - hours * 3600_000;
  const bucket = bucketMinutes * 60_000;
  return db()
    .prepare(
      `SELECT (ts / ?) * ? AS t, AVG(hashrate_10m) AS h, AVG(reject) AS reject
       FROM snapshots WHERE worker = ? AND ts >= ?
       GROUP BY t ORDER BY t`,
    )
    .all(bucket, bucket, worker, since) as { t: number; h: number; reject: number }[];
}

/** Serie temporal da fazenda inteira. */
export function fleetSeries(hours: number, bucketMinutes = 10): { t: number; h: number; h1h: number; active: number; reject: number }[] {
  const since = Date.now() - hours * 3600_000;
  const bucket = bucketMinutes * 60_000;
  return db()
    .prepare(
      `SELECT (ts / ?) * ? AS t, AVG(hashrate_10m) AS h, AVG(hashrate_1h) AS h1h,
              AVG(active) AS active, AVG(reject) AS reject
       FROM fleet_snapshots WHERE ts >= ?
       GROUP BY t ORDER BY t`,
    )
    .all(bucket, bucket, since) as { t: number; h: number; h1h: number; active: number; reject: number }[];
}

export function recentSparklines(hours = 6, bucketMinutes = 15): Map<string, { t: number; h: number }[]> {
  const since = Date.now() - hours * 3600_000;
  const bucket = bucketMinutes * 60_000;
  const rows = db()
    .prepare(
      `SELECT worker, (ts / ?) * ? AS t, AVG(hashrate_10m) AS h
       FROM snapshots WHERE ts >= ? GROUP BY worker, t ORDER BY t`,
    )
    .all(bucket, bucket, since) as { worker: string; t: number; h: number }[];
  const map = new Map<string, { t: number; h: number }[]>();
  for (const r of rows) {
    const arr = map.get(r.worker) ?? [];
    arr.push({ t: r.t, h: r.h });
    map.set(r.worker, arr);
  }
  return map;
}

/**
 * Leituras de 10min por maquina numa janela curta.
 * A leitura instantanea da pool oscila bastante (a mesma maquina varia +-30%
 * entre coletas), entao usamos a mediana desta janela para decidir status e
 * alerta: reage em poucos minutos sem tremer com o ruido.
 */
export function recentHashrates(minutes: number): Map<string, number[]> {
  const since = Date.now() - minutes * 60_000;
  const rows = db()
    .prepare('SELECT worker, hashrate_10m FROM snapshots WHERE ts >= ? ORDER BY ts')
    .all(since) as { worker: string; hashrate_10m: number }[];

  const map = new Map<string, number[]>();
  for (const r of rows) {
    const arr = map.get(r.worker) ?? [];
    arr.push(r.hashrate_10m);
    map.set(r.worker, arr);
  }
  return map;
}

export function profitDays(limit = 90): { date: string; total: number; pps: number; pplns: number; solo: number }[] {
  return db()
    .prepare('SELECT date, total, pps, pplns, solo FROM profit_days ORDER BY date DESC LIMIT ?')
    .all(limit) as { date: string; total: number; pps: number; pplns: number; solo: number }[];
}

export function payments(limit = 60): { id: number; amount: number; address: string; tx: string; create_time: number }[] {
  return db()
    .prepare('SELECT id, amount, address, tx, create_time FROM payments ORDER BY create_time DESC LIMIT ?')
    .all(limit) as { id: number; amount: number; address: string; tx: string; create_time: number }[];
}

// ------------------------------------------------------------------ contas de energia

export interface EnergyBillRow {
  month: string;
  sats: number;
  paid_at: number | null;
  note: string;
  mined_manual: number | null;
  invoice_usd: number | null;
  /** abatimento que veio nesta fatura, em dolar */
  credit_applied_usd: number | null;
  /** competencia de onde veio esse abatimento */
  credit_applied_month: string | null;
  updated: number;
}

export function energyBills(): EnergyBillRow[] {
  return db()
    .prepare(
      `SELECT month, sats, paid_at, note, mined_manual, invoice_usd,
              credit_applied_usd, credit_applied_month, updated
       FROM energy_bills ORDER BY month DESC`,
    )
    .all() as unknown as EnergyBillRow[];
}

export interface EnergyBillInput {
  month: string;
  sats: number;
  paidAt: number | null;
  note: string;
  minedManual: number | null;
  invoiceUsd: number | null;
  creditAppliedUsd: number | null;
  creditAppliedMonth: string | null;
}

export function saveEnergyBill(b: EnergyBillInput): void {
  db()
    .prepare(
      `INSERT INTO energy_bills (month, sats, paid_at, note, mined_manual, invoice_usd,
                                 credit_applied_usd, credit_applied_month, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET sats = excluded.sats, paid_at = excluded.paid_at,
         note = excluded.note, mined_manual = excluded.mined_manual,
         invoice_usd = excluded.invoice_usd,
         credit_applied_usd = excluded.credit_applied_usd,
         credit_applied_month = excluded.credit_applied_month,
         updated = excluded.updated`,
    )
    .run(
      b.month,
      Math.round(b.sats),
      b.paidAt,
      b.note,
      b.minedManual === null ? null : Math.round(b.minedManual),
      b.invoiceUsd,
      b.creditAppliedUsd,
      b.creditAppliedMonth,
      Date.now(),
    );
}

export function deleteEnergyBill(month: string): void {
  db().prepare('DELETE FROM energy_bills WHERE month = ?').run(month);
}

/**
 * BTC recebido por mes, a partir dos pagamentos.
 * A ViaBTC so mantem ~30 dias de historico diario, mas os pagamentos alcancam
 * mais longe — viram a fonte de producao dos meses que o diario nao cobre.
 */
export function paidByMonth(): Map<string, { btc: number; count: number; first: number; last: number }> {
  const rows = db()
    .prepare(
      `SELECT strftime('%Y-%m', create_time / 1000, 'unixepoch') AS month,
              SUM(amount) AS btc, COUNT(*) AS count,
              MIN(create_time) AS first, MAX(create_time) AS last
       FROM payments GROUP BY month ORDER BY month DESC`,
    )
    .all() as { month: string; btc: number; count: number; first: number; last: number }[];
  return new Map(rows.map((r) => [r.month, { btc: r.btc, count: r.count, first: r.first, last: r.last }]));
}

/** BTC minerado por mes de competencia, a partir do historico diario da pool. */
export function minedByMonth(): Map<string, { btc: number; days: number }> {
  const rows = db()
    .prepare(
      `SELECT substr(date, 1, 7) AS month, SUM(total) AS btc, COUNT(*) AS days
       FROM profit_days GROUP BY month ORDER BY month DESC`,
    )
    .all() as { month: string; btc: number; days: number }[];
  return new Map(rows.map((r) => [r.month, { btc: r.btc, days: r.days }]));
}

export function recentEvents(limit = 100): { id: number; ts: number; worker: string | null; level: string; kind: string; detail: string }[] {
  return db()
    .prepare('SELECT id, ts, worker, level, kind, detail FROM events ORDER BY ts DESC LIMIT ?')
    .all(limit) as { id: number; ts: number; worker: string | null; level: string; kind: string; detail: string }[];
}

export interface WorkerDowntime {
  worker: string;
  /** janela observada, ms */
  coverageMs: number;
  /** tempo em que a maquina realmente produziu, ms */
  activeMs: number;
  /** tempo parado dentro da janela, ms */
  downMs: number;
}

/**
 * A ViaBTC republica o last_active a cada ~5 minutos (medido: salto mediano de
 * 301s, muito regular). Uma maquina em operacao normal nunca fica mais que
 * isso sem atualizar.
 */
const REPORT_MS = 5 * 60_000;
/** Acima disso o intervalo sem share deixa de ser cadencia e vira parada. */
const GRACE_MS = 8 * 60_000;
/** Coletas mais espacadas que isso sao lacuna nossa, nao parada da maquina. */
const MAX_GAP_MS = 10 * 60_000;

/**
 * Tempo parado por maquina, somado intervalo a intervalo.
 *
 * Nao da para usar o hashrate: a media de 10 minutos da pool decai devagar e
 * so chega a zero muito depois da parada. Usamos o last_active, que so avanca
 * enquanto a maquina envia share.
 *
 * O ponto delicado e que, ao voltar, o last_active salta de uma vez cobrindo
 * toda a queda. Por isso limitamos o quanto cada intervalo pode ter produzido
 * ao tempo decorrido nele: durante a parada soma-se o intervalo inteiro como
 * parada e, no salto da volta, soma-se zero. Comparar apenas os extremos da
 * janela apagaria a queda assim que ela terminasse.
 */
export function downtimeByWorker(since: number, until = Number.MAX_SAFE_INTEGER): WorkerDowntime[] {
  const rows = db()
    .prepare(
      `WITH d AS (
         SELECT worker,
                ts - LAG(ts) OVER (PARTITION BY worker ORDER BY ts) AS elapsed,
                last_active - LAG(last_active) OVER (PARTITION BY worker ORDER BY ts) AS gap
         FROM snapshots
         WHERE ts >= ? AND ts < ? AND last_active IS NOT NULL
       )
       SELECT worker,
              SUM(elapsed) AS observed,
              SUM(CASE WHEN gap > ? THEN gap - ? ELSE 0 END) AS down
       FROM d
       WHERE elapsed IS NOT NULL AND elapsed > 0 AND elapsed <= ?
       GROUP BY worker ORDER BY worker`,
    )
    .all(since, until, GRACE_MS, REPORT_MS, MAX_GAP_MS) as {
    worker: string;
    observed: number;
    down: number;
  }[];

  // Parada ainda em curso nao aparece acima: o intervalo entre shares so se
  // fecha quando a maquina volta. Ate la, o que temos e a distancia entre a
  // ultima coleta e o ultimo share — que ja e tempo parado.
  const abertas = db()
    .prepare(
      `WITH u AS (
         SELECT worker, ts, last_active,
                ROW_NUMBER() OVER (PARTITION BY worker ORDER BY ts DESC) AS rn
         FROM snapshots WHERE ts >= ? AND ts < ? AND last_active IS NOT NULL
       )
       SELECT worker, ts - last_active AS aberto FROM u WHERE rn = 1`,
    )
    .all(since, until) as { worker: string; aberto: number }[];

  const emCurso = new Map(
    abertas
      .filter((a) => a.aberto > GRACE_MS)
      .map((a) => [a.worker, a.aberto - REPORT_MS]),
  );

  return rows.map((r) => {
    const downMs = Math.max(0, (r.down ?? 0) + (emCurso.get(r.worker) ?? 0));
    return {
      worker: r.worker,
      coverageMs: r.observed,
      activeMs: Math.max(0, r.observed - downMs),
      downMs,
    };
  });
}

/** Tempo em que a fazenda inteira esteve parada ao mesmo tempo. */
export function upsertChart(
  interval: 'min' | 'hour' | 'day',
  points: { ts: number; hashrate: number; reject: number }[],
): void {
  const stmt = db().prepare(
    `INSERT INTO pool_chart (ts, interval, hashrate, reject) VALUES (?, ?, ?, ?)
     ON CONFLICT(ts, interval) DO UPDATE SET hashrate = excluded.hashrate, reject = excluded.reject`,
  );
  for (const p of points) stmt.run(p.ts, interval, p.hashrate, p.reject);
}

export interface OutagePeriod {
  from: number;
  to: number;
  ms: number;
}

/**
 * Quedas totais da fazenda vistas na serie importada da pool.
 *
 * Cuidado necessario: a serie diaria vem preenchida com zeros para os dias
 * anteriores ao historico real, e a de 10 minutos so cobre 24 horas. Por isso
 * so consideramos zeros que estejam dentro do trecho realmente povoado — entre
 * o primeiro e o ultimo ponto com producao.
 */
export function chartOutages(
  interval: 'min' | 'hour',
  from: number,
  to: number,
): { periods: OutagePeriod[]; totalMs: number; covered: { from: number; to: number } | null } {
  const stepMs = interval === 'min' ? 10 * 60_000 : 60 * 60_000;
  const rows = db()
    .prepare('SELECT ts, hashrate FROM pool_chart WHERE interval = ? AND ts >= ? AND ts < ? ORDER BY ts')
    .all(interval, from, to) as { ts: number; hashrate: number }[];

  if (rows.length === 0) return { periods: [], totalMs: 0, covered: null };

  // Recorta ao trecho com producao de verdade, descartando o zero de padding.
  const first = rows.findIndex((r) => r.hashrate > 0);
  const last = rows.map((r) => r.hashrate > 0).lastIndexOf(true);
  if (first < 0 || last <= first) return { periods: [], totalMs: 0, covered: null };

  const janela = rows.slice(first, last + 1);
  const periods: OutagePeriod[] = [];
  let atual: OutagePeriod | null = null;

  for (const r of janela) {
    if (r.hashrate <= 0) {
      if (atual && r.ts === atual.to) atual.to = r.ts + stepMs;
      else {
        if (atual) periods.push(atual);
        atual = { from: r.ts, to: r.ts + stepMs, ms: 0 };
      }
    } else if (atual) {
      periods.push(atual);
      atual = null;
    }
  }
  if (atual) periods.push(atual);

  for (const p of periods) p.ms = p.to - p.from;

  return {
    periods,
    totalMs: periods.reduce((a, p) => a + p.ms, 0),
    covered: { from: janela[0].ts, to: janela[janela.length - 1].ts + stepMs },
  };
}

/**
 * Grava o consolidado de indisponibilidade da competencia.
 *
 * Roda com os snapshots ainda em disco; depois da poda, o relatorio passa a ler
 * daqui. Como uma parada em curso so cresce, o valor gravado nunca diminui —
 * o relatorio usa sempre o maior entre o calculado e o persistido.
 */
export function persistMonthlyDowntime(month: string, since: number, until: number): void {
  const porWorker = downtimeByWorker(since, until);
  if (porWorker.length === 0) return;

  const conn = db();
  const stmt = conn.prepare(
    `INSERT INTO downtime_monthly (month, worker, down_ms, observed_ms, updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(month, worker) DO UPDATE SET
       down_ms     = MAX(down_ms, excluded.down_ms),
       observed_ms = MAX(observed_ms, excluded.observed_ms),
       updated     = excluded.updated`,
  );
  const agora = Date.now();
  conn.exec('BEGIN');
  try {
    for (const w of porWorker) stmt.run(month, w.worker, Math.round(w.downMs), Math.round(w.coverageMs), agora);
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }

  const outage = fullOutages(since, until);
  persistOutageEvents(month, outage.periods);
  persistMinerOutages(month, minerOutagePeriods(since, until));
  const primeira = firstSnapshotSince(since, until);
  conn
    .prepare(
      `INSERT INTO outage_monthly (month, full_outage_ms, observed_from, updated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET
         full_outage_ms = MAX(full_outage_ms, excluded.full_outage_ms),
         observed_from  = COALESCE(MIN(observed_from, excluded.observed_from), excluded.observed_from),
         updated        = excluded.updated`,
    )
    .run(month, Math.round(outage.downMs), primeira, agora);
}

export function persistedDowntime(month: string): Map<string, WorkerDowntime> {
  const rows = db()
    .prepare('SELECT worker, down_ms, observed_ms FROM downtime_monthly WHERE month = ?')
    .all(month) as { worker: string; down_ms: number; observed_ms: number }[];
  return new Map(
    rows.map((r) => [
      r.worker,
      {
        worker: r.worker,
        downMs: r.down_ms,
        coverageMs: r.observed_ms,
        activeMs: Math.max(0, r.observed_ms - r.down_ms),
      },
    ]),
  );
}

export function persistedOutage(month: string): { downMs: number; observedFrom: number | null } | null {
  const r = db()
    .prepare('SELECT full_outage_ms, observed_from FROM outage_monthly WHERE month = ?')
    .get(month) as { full_outage_ms: number; observed_from: number | null } | undefined;
  return r ? { downMs: r.full_outage_ms, observedFrom: r.observed_from } : null;
}

/**
 * Marca ou limpa o inicio da degradacao.
 * So grava na transicao: enquanto a maquina segue degradada, o instante
 * original e preservado, que e justamente o que mede a duracao.
 */
export function markDegraded(worker: string, degraded: boolean, at: number): void {
  const conn = db();
  const atual = conn.prepare('SELECT degraded_since FROM miner_health WHERE worker = ?').get(worker) as
    | { degraded_since: number | null }
    | undefined;

  if (degraded) {
    if (atual?.degraded_since) return;
    conn
      .prepare(
        `INSERT INTO miner_health (worker, degraded_since) VALUES (?, ?)
         ON CONFLICT(worker) DO UPDATE SET degraded_since = excluded.degraded_since`,
      )
      .run(worker, at);
    return;
  }

  if (atual?.degraded_since) {
    conn.prepare('UPDATE miner_health SET degraded_since = NULL WHERE worker = ?').run(worker);
  }
}

export function degradedSinceMap(): Map<string, number> {
  const rows = db()
    .prepare('SELECT worker, degraded_since FROM miner_health WHERE degraded_since IS NOT NULL')
    .all() as { worker: string; degraded_since: number }[];
  return new Map(rows.map((r) => [r.worker, r.degraded_since]));
}

/** Primeira coleta dentro do periodo — inicio real da observacao. */
export function firstSnapshotSince(since: number, until = Number.MAX_SAFE_INTEGER): number | null {
  const r = db()
    .prepare('SELECT MIN(ts) AS t FROM snapshots WHERE ts >= ? AND ts < ?')
    .get(since, until) as { t: number | null };
  return r?.t ?? null;
}

export function fullOutages(
  since: number,
  until = Number.MAX_SAFE_INTEGER,
): { downMs: number; intervals: number; periods: OutagePeriod[] } {
  const rows = db()
    .prepare(
      `SELECT ts,
              COUNT(*) AS n,
              SUM(CASE WHEN ts - last_active > ? THEN 1 ELSE 0 END) AS down
       FROM snapshots
       WHERE ts >= ? AND ts < ? AND last_active IS NOT NULL
       GROUP BY ts ORDER BY ts`,
    )
    .all(GRACE_MS, since, until) as { ts: number; n: number; down: number }[];

  if (rows.length < 2) return { downMs: 0, intervals: 0, periods: [] };

  // Cada coleta representa o intervalo ate a proxima; ignoramos saltos longos,
  // que sao lacuna do coletor e nao queda da fazenda.
  let downMs = 0;
  let intervals = 0;
  const periods: OutagePeriod[] = [];
  let aberto: { from: number; to: number } | null = null;

  for (let i = 1; i < rows.length; i++) {
    const elapsed = rows[i].ts - rows[i - 1].ts;
    const cheia = elapsed > 0 && elapsed <= MAX_GAP_MS && rows[i].n > 0 && rows[i].down === rows[i].n;

    if (cheia) {
      downMs += elapsed;
      intervals++;
      if (aberto) aberto.to = rows[i].ts;
      else aberto = { from: rows[i - 1].ts, to: rows[i].ts };
    } else if (aberto) {
      periods.push({ from: aberto.from, to: aberto.to, ms: aberto.to - aberto.from });
      aberto = null;
    }
  }
  if (aberto) periods.push({ from: aberto.from, to: aberto.to, ms: aberto.to - aberto.from });

  return { downMs, intervals, periods };
}

export function persistOutageEvents(month: string, periods: OutagePeriod[]): void {
  const stmt = db().prepare(
    `INSERT INTO outage_events (from_ts, to_ts, month) VALUES (?, ?, ?)
     ON CONFLICT(from_ts) DO UPDATE SET to_ts = MAX(to_ts, excluded.to_ts)`,
  );
  for (const p of periods) stmt.run(p.from, p.to, month);
}

export interface MinerOutage extends OutagePeriod {
  worker: string;
}

/**
 * Paradas de cada maquina no periodo. Uma maquina esta parada enquanto o
 * ultimo share estiver mais distante que a tolerancia de republicacao.
 */
export function minerOutagePeriods(since: number, until: number): MinerOutage[] {
  const rows = db()
    .prepare(
      `SELECT worker, ts, CASE WHEN ts - last_active > ? THEN 1 ELSE 0 END AS down
       FROM snapshots WHERE ts >= ? AND ts < ? AND last_active IS NOT NULL
       ORDER BY worker, ts`,
    )
    .all(GRACE_MS, since, until) as { worker: string; ts: number; down: number }[];

  const out: MinerOutage[] = [];
  let atual: MinerOutage | null = null;
  let anterior: { worker: string; ts: number } | null = null;

  for (const r of rows) {
    const mesmoWorker = anterior?.worker === r.worker;
    const elapsed = mesmoWorker ? r.ts - anterior!.ts : 0;
    const contiguo = mesmoWorker && elapsed > 0 && elapsed <= MAX_GAP_MS;

    if (r.down && contiguo) {
      if (atual && atual.worker === r.worker) atual.to = r.ts;
      else {
        if (atual) out.push(atual);
        atual = { worker: r.worker, from: anterior!.ts, to: r.ts, ms: 0 };
      }
    } else if (atual) {
      out.push(atual);
      atual = null;
    }
    anterior = { worker: r.worker, ts: r.ts };
  }
  if (atual) out.push(atual);

  for (const p of out) p.ms = p.to - p.from;
  return out.filter((p) => p.ms > 0);
}

export function persistMinerOutages(month: string, periods: MinerOutage[]): void {
  const stmt = db().prepare(
    `INSERT INTO miner_outage_events (worker, from_ts, to_ts, month) VALUES (?, ?, ?, ?)
     ON CONFLICT(worker, from_ts) DO UPDATE SET to_ts = MAX(to_ts, excluded.to_ts)`,
  );
  for (const p of periods) stmt.run(p.worker, p.from, p.to, month);
}

export function minerOutageEvents(month: string): MinerOutage[] {
  const rows = db()
    .prepare('SELECT worker, from_ts, to_ts FROM miner_outage_events WHERE month = ? ORDER BY from_ts, worker')
    .all(month) as { worker: string; from_ts: number; to_ts: number }[];
  return rows.map((r) => ({ worker: r.worker, from: r.from_ts, to: r.to_ts, ms: r.to_ts - r.from_ts }));
}

export function outageEvents(month: string): OutagePeriod[] {
  const rows = db()
    .prepare('SELECT from_ts, to_ts FROM outage_events WHERE month = ? ORDER BY from_ts')
    .all(month) as { from_ts: number; to_ts: number }[];
  return rows.map((r) => ({ from: r.from_ts, to: r.to_ts, ms: r.to_ts - r.from_ts }));
}

export function snapshotCount(): number {
  const r = db().prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number };
  return r.c;
}

/** Descarta amostras antigas para o banco nao crescer sem limite. */
export function pruneOldData(days = 45): void {
  const cutoff = Date.now() - days * 86_400_000;
  db().prepare('DELETE FROM snapshots WHERE ts < ?').run(cutoff);
  db().prepare('DELETE FROM fleet_snapshots WHERE ts < ?').run(cutoff);
  db().prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
}
