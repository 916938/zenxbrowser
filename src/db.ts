import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** 签到数据库：项目根下的 zenxbrowser/checkin.db。 */
export const DEFAULT_DB_FILE = fileURLToPath(new URL("../zenxbrowser/checkin.db", import.meta.url));

export type CheckinRecord = {
  /** 打卡完成时间（ISO 8601，UTC）。 */
  time: string;
  alias: string;
  instanceId: string;
  identity: string;
  ok: boolean;
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** 是否确认到账（余额增加或出现"签到成功"提示）。 */
  credited: boolean;
  /** 失败时的错误码，成功为 null。 */
  errorCode: string | null;
};

export type CheckinRow = CheckinRecord & { id: number };

export type AccountSummary = {
  alias: string;
  identity: string;
  /** 总签到次数（含失败）。 */
  total: number;
  /** 确认到账次数。 */
  credited: number;
  /** 最近一条非 NULL 的打卡后余额。 */
  currentBalance: number | null;
  /** 所有余额正增长之和（只统计实际增长）。 */
  totalGained: number;
  /** 最近一次打卡时间（UTC ISO）。 */
  lastTime: string | null;
  /** 最近一次结果。 */
  lastOk: boolean | null;
  lastErrorCode: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  time           TEXT    NOT NULL,
  alias          TEXT    NOT NULL,
  instance_id    TEXT    NOT NULL,
  identity       TEXT    NOT NULL,
  ok             INTEGER NOT NULL,
  balance_before REAL,
  balance_after  REAL,
  credited       INTEGER NOT NULL,
  error_code     TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkins_time  ON checkins(time);
CREATE INDEX IF NOT EXISTS idx_checkins_alias ON checkins(alias, time);
`;

/**
 * 每日余额/消耗快照。签到记录只在"签到那一刻"有余额，账号被单独使用时
 * 两次签到之间的消耗完全看不见——这张表就是为周/月消耗对比留的连续观测点。
 */
const SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  time         TEXT    NOT NULL,
  alias        TEXT    NOT NULL,
  instance_id  TEXT    NOT NULL,
  identity     TEXT    NOT NULL,
  balance      REAL,
  total_spent  REAL,
  ok           INTEGER NOT NULL,
  error_code   TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_time  ON balance_snapshots(time);
CREATE INDEX IF NOT EXISTS idx_snapshots_alias ON balance_snapshots(alias, time);
`;

/** 打开数据库并确保 schema 存在。目录不存在时自动创建。 */
export function openDatabase(file: string = DEFAULT_DB_FILE): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec(SNAPSHOT_SCHEMA);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/** 追加一条签到记录。目录不存在时自动创建。 */
export function insertCheckin(record: CheckinRecord, file: string = DEFAULT_DB_FILE): void {
  const db = openDatabase(file);
  try {
    db.prepare(`
      INSERT INTO checkins
        (time, alias, instance_id, identity, ok, balance_before, balance_after, credited, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.time,
      record.alias,
      record.instanceId,
      record.identity,
      record.ok ? 1 : 0,
      record.balanceBefore,
      record.balanceAfter,
      record.credited ? 1 : 0,
      record.errorCode,
    );
  } finally {
    db.close();
  }
}

/**
 * 指定账号在 [start, end) 区间内是否已有"确认到账"的记录。
 * 供签到前的"今天已到账"短路使用：区间用调用方算好的 UTC ISO 边界，
 * 避免把本地"今天"错算成 UTC 的前一天/后一天。
 */
export function hasCreditedBetween(
  alias: string,
  start: string,
  end: string,
  file: string = DEFAULT_DB_FILE,
): boolean {
  const db = openDatabase(file);
  try {
    const row = db.prepare(
      "SELECT 1 AS hit FROM checkins WHERE alias = ? AND credited = 1 AND time >= ? AND time < ? LIMIT 1",
    ).get(alias, start, end);
    return row !== undefined;
  } finally {
    db.close();
  }
}

function toRow(row: Record<string, unknown>): CheckinRow {
  return {
    id: row.id as number,
    time: row.time as string,
    alias: row.alias as string,
    instanceId: row.instance_id as string,
    identity: row.identity as string,
    ok: row.ok === 1,
    balanceBefore: (row.balance_before as number | null) ?? null,
    balanceAfter: (row.balance_after as number | null) ?? null,
    credited: row.credited === 1,
    errorCode: (row.error_code as string | null) ?? null,
  };
}

/** 查询明细，按时间倒序。可按账号过滤、限制条数。 */
export function listCheckins(
  options: { alias?: string; limit?: number } = {},
  file: string = DEFAULT_DB_FILE,
): CheckinRow[] {
  const db = openDatabase(file);
  try {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 500)), 5_000);
    if (options.alias) {
      const rows = db.prepare(
        "SELECT * FROM checkins WHERE alias = ? ORDER BY time DESC, id DESC LIMIT ?",
      ).all(options.alias, limit);
      return (rows as Record<string, unknown>[]).map(toRow);
    }
    const rows = db.prepare(
      "SELECT * FROM checkins ORDER BY time DESC, id DESC LIMIT ?",
    ).all(limit);
    return (rows as Record<string, unknown>[]).map(toRow);
  } finally {
    db.close();
  }
}

/**
 * 按账号汇总。累计到账只统计余额实际正增长；当天重复签到（credited 但余额不变）
 * 计入成功次数，不计入金额——与站点实际发放规则一致。
 */
export function summarizeAccounts(file: string = DEFAULT_DB_FILE): AccountSummary[] {
  const db = openDatabase(file);
  try {
    const rows = db.prepare(`
      SELECT
        alias,
        identity,
        COUNT(*)                                              AS total,
        SUM(CASE WHEN credited = 1 THEN 1 ELSE 0 END)          AS credited,
        SUM(CASE
              WHEN balance_after IS NOT NULL
               AND balance_before IS NOT NULL
               AND balance_after > balance_before
              THEN balance_after - balance_before ELSE 0 END)  AS total_gained,
        SUM(CASE WHEN balance_after IS NULL THEN 0 ELSE 1 END) AS has_balance
      FROM checkins
      GROUP BY alias, identity
      ORDER BY alias
    `).all() as Record<string, unknown>[];

    const latest = db.prepare(`
      SELECT c.alias, c.time, c.ok, c.error_code, c.balance_after
      FROM checkins c
      JOIN (SELECT alias, MAX(id) AS max_id FROM checkins GROUP BY alias) m
        ON c.id = m.max_id
    `).all() as Record<string, unknown>[];
    const latestByAlias = new Map(latest.map((row) => [row.alias as string, row]));

    const lastBalance = db.prepare(`
      SELECT c.alias, c.balance_after
      FROM checkins c
      JOIN (
        SELECT alias, MAX(id) AS max_id FROM checkins
        WHERE balance_after IS NOT NULL GROUP BY alias
      ) m ON c.id = m.max_id
    `).all() as Record<string, unknown>[];
    const balanceByAlias = new Map(lastBalance.map((row) => [row.alias as string, row.balance_after as number]));

    return rows.map((row) => {
      const alias = row.alias as string;
      const last = latestByAlias.get(alias);
      return {
        alias,
        identity: row.identity as string,
        total: row.total as number,
        credited: row.credited as number,
        currentBalance: balanceByAlias.get(alias) ?? null,
        totalGained: Math.round(((row.total_gained as number) ?? 0) * 100) / 100,
        lastTime: (last?.time as string) ?? null,
        lastOk: last === undefined ? null : last.ok === 1,
        lastErrorCode: (last?.error_code as string | null) ?? null,
      };
    });
  } finally {
    db.close();
  }
}

/**
 * 该账号在 timeIso 之前的最后一次已知余额（balance_after 非 NULL）。
 * 供复查时当"发放前基准"：与当前余额比较即可判断当日额度是否已发放。
 * 没有更早的记录时返回 null（新账号首次签到没有基准可比）。
 */
export function lastBalanceBefore(alias: string, timeIso: string, file: string = DEFAULT_DB_FILE): number | null {
  const db = openDatabase(file);
  try {
    const row = db.prepare(
      "SELECT balance_after FROM checkins WHERE alias = ? AND balance_after IS NOT NULL AND time < ? ORDER BY time DESC, id DESC LIMIT 1",
    ).get(alias, timeIso) as { balance_after?: number | null } | undefined;
    return row?.balance_after ?? null;
  } finally {
    db.close();
  }
}

export type SnapshotRecord = {
  /** 采集时间（ISO 8601，UTC）。 */
  time: string;
  alias: string;
  instanceId: string;
  identity: string;
  /** 当前余额；页面未渲染出余额时为 null。 */
  balance: number | null;
  /** 站点"历史消耗"累计值；读不到时为 null。差分即区间真实消耗。 */
  totalSpent: number | null;
  /** 采集是否成功（未登录/身份不符等也写快照，但记为失败，保证"每天都试过"有痕）。 */
  ok: boolean;
  errorCode: string | null;
};

export type SnapshotRow = SnapshotRecord & { id: number };

/** 追加一条余额/消耗快照。 */
export function insertSnapshot(record: SnapshotRecord, file: string = DEFAULT_DB_FILE): void {
  const db = openDatabase(file);
  try {
    db.prepare(`
      INSERT INTO balance_snapshots
        (time, alias, instance_id, identity, balance, total_spent, ok, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.time,
      record.alias,
      record.instanceId,
      record.identity,
      record.balance,
      record.totalSpent,
      record.ok ? 1 : 0,
      record.errorCode,
    );
  } finally {
    db.close();
  }
}

/** 查询快照明细，按时间倒序。可按账号过滤、限制条数。 */
export function listSnapshots(
  options: { alias?: string; limit?: number } = {},
  file: string = DEFAULT_DB_FILE,
): SnapshotRow[] {
  const db = openDatabase(file);
  try {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 500)), 5_000);
    const rows = options.alias
      ? db.prepare("SELECT * FROM balance_snapshots WHERE alias = ? ORDER BY time DESC, id DESC LIMIT ?").all(options.alias, limit)
      : db.prepare("SELECT * FROM balance_snapshots ORDER BY time DESC, id DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as number,
      time: row.time as string,
      alias: row.alias as string,
      instanceId: row.instance_id as string,
      identity: row.identity as string,
      balance: (row.balance as number | null) ?? null,
      totalSpent: (row.total_spent as number | null) ?? null,
      ok: row.ok === 1,
      errorCode: (row.error_code as string | null) ?? null,
    }));
  } finally {
    db.close();
  }
}

export type RangeRow = {
  alias: string;
  identity: string;
  /** 区间内签到到账（只统计余额真实增长，与报表口径一致）。 */
  credited: number;
  /** 区间内消耗（站点累计消耗的增量）；缺少起止快照时为 null。 */
  spent: number | null;
  balanceStart: number | null;
  balanceEnd: number | null;
  /** 区间内签到次数与成功次数。 */
  checkins: number;
  checkinsOk: number;
  /** 区间内快照条数（0 表示这段没有观测点，消耗无从计算）。 */
  snapshots: number;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 区间汇总（周/月对比用）：签到到账、真实消耗、余额起止。
 *
 * 消耗取"站点累计消耗的增量"而不是"余额差"：余额同时被发放和消耗影响，
 * 用余额差会把"没签到"误算成"花多了"。累计消耗只增不减，差分即真实花费。
 */
export function rangeSummary(startIso: string, endIso: string, file: string = DEFAULT_DB_FILE): RangeRow[] {
  const db = openDatabase(file);
  try {
    const aliases = new Set<string>();
    for (const row of db.prepare("SELECT DISTINCT alias FROM checkins").all() as { alias: string }[]) aliases.add(row.alias);
    for (const row of db.prepare("SELECT DISTINCT alias FROM balance_snapshots").all() as { alias: string }[]) aliases.add(row.alias);

    const checkinStmt = db.prepare(`
      SELECT
        COUNT(*) AS n,
        COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS ok,
        COALESCE(SUM(CASE
          WHEN balance_after IS NOT NULL AND balance_before IS NOT NULL AND balance_after > balance_before
          THEN balance_after - balance_before ELSE 0 END), 0) AS gain
      FROM checkins WHERE alias = ? AND time >= ? AND time < ?
    `);
    const snapStmt = db.prepare("SELECT balance, total_spent FROM balance_snapshots WHERE alias = ? AND time >= ? AND time < ? AND ok = 1 ORDER BY time, id");
    const beforeStmt = db.prepare("SELECT total_spent FROM balance_snapshots WHERE alias = ? AND time < ? AND ok = 1 ORDER BY time DESC, id DESC LIMIT 1");
    const identityStmt = db.prepare(`
      SELECT identity FROM (
        SELECT identity, time FROM checkins WHERE alias = ?
        UNION ALL
        SELECT identity, time FROM balance_snapshots WHERE alias = ?
      ) ORDER BY time DESC, identity LIMIT 1
    `);

    return [...aliases].sort().map((alias) => {
      const checkin = checkinStmt.get(alias, startIso, endIso) as { n: number; ok: number; gain: number };
      const snaps = snapStmt.all(alias, startIso, endIso) as { balance: number | null; total_spent: number | null }[];
      const first = snaps[0];
      const last = snaps[snaps.length - 1];
      let spent: number | null = null;
      if (last?.total_spent != null) {
        const before = beforeStmt.get(alias, startIso) as { total_spent: number | null } | undefined;
        const base = before?.total_spent ?? first?.total_spent ?? null;
        if (base != null) spent = round2(last.total_spent - base);
      }
      const identity = identityStmt.get(alias, alias) as { identity: string } | undefined;
      return {
        alias,
        identity: identity?.identity ?? "",
        credited: round2(checkin.gain ?? 0),
        spent,
        balanceStart: first?.balance ?? null,
        balanceEnd: last?.balance ?? null,
        checkins: checkin.n ?? 0,
        checkinsOk: checkin.ok ?? 0,
        snapshots: snaps.length,
      };
    });
  } finally {
    db.close();
  }
}

export type DailyTotal = {
  /** 本地日（YYYY-MM-DD）。 */
  day: string;
  /** 当日各账号最后一次快照的余额之和；当天没有任何快照时为 null。 */
  balanceSum: number | null;
  /** 计入余额总额的账号数。 */
  balanceAccounts: number;
  /** 当日消耗（各账号"历史消耗"增量）之和；无可比基准时为 null。 */
  spentSum: number | null;
  /** 可计算消耗的账号数（需要当天与更早各有一个观测点）。 */
  spentAccounts: number;
  /** 当日签到到账（余额真实增长）之和。 */
  creditedSum: number;
};

function localDay(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 每日总额：余额合计、消耗合计、签到到账合计。
 *
 * 每个账号每天只取**最后一次**快照（一天采多次以末次为准）；消耗用"历史消耗"
 * 相对该账号上一个观测点的增量，负值（站点重置之类）视为异常不计入——宁可少算
 * 也不制造假数据。只统计真正有观测点的账号，并把覆盖账号数一并返回，
 * 避免"某天只采了 3 个号"被当成全员总额。
 */
export function dailyTotals(options: { days?: number } = {}, file: string = DEFAULT_DB_FILE): DailyTotal[] {
  const db = openDatabase(file);
  try {
    const snapshots = db.prepare(
      "SELECT alias, time, balance, total_spent FROM balance_snapshots WHERE ok = 1 ORDER BY time, id",
    ).all() as { alias: string; time: string; balance: number | null; total_spent: number | null }[];

    const perAlias = new Map<string, Map<string, { balance: number | null; totalSpent: number | null }>>();
    for (const row of snapshots) {
      if (!perAlias.has(row.alias)) perAlias.set(row.alias, new Map());
      // 同一天多次采集时后写的覆盖先写的（已按时间排序）。
      perAlias.get(row.alias)!.set(localDay(row.time), { balance: row.balance ?? null, totalSpent: row.total_spent ?? null });
    }

    const totals = new Map<string, { balanceSum: number; balanceAccounts: number; spentSum: number; spentAccounts: number }>();
    const entryFor = (day: string) => {
      const existing = totals.get(day);
      if (existing) return existing;
      const created = { balanceSum: 0, balanceAccounts: 0, spentSum: 0, spentAccounts: 0 };
      totals.set(day, created);
      return created;
    };

    for (const days of perAlias.values()) {
      let previousSpent: number | null = null;
      for (const [day, value] of [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const entry = entryFor(day);
        if (value.balance !== null) {
          entry.balanceSum += value.balance;
          entry.balanceAccounts += 1;
        }
        if (value.totalSpent !== null) {
          if (previousSpent !== null) {
            const delta = value.totalSpent - previousSpent;
            if (delta >= 0) {
              entry.spentSum += delta;
              entry.spentAccounts += 1;
            }
          }
          previousSpent = value.totalSpent;
        }
      }
    }

    const credited = new Map<string, number>();
    const checkins = db.prepare("SELECT time, balance_before, balance_after FROM checkins").all() as
      { time: string; balance_before: number | null; balance_after: number | null }[];
    for (const row of checkins) {
      if (row.balance_after === null || row.balance_before === null || row.balance_after <= row.balance_before) continue;
      const day = localDay(row.time);
      credited.set(day, (credited.get(day) ?? 0) + (row.balance_after - row.balance_before));
    }

    const days = [...new Set([...totals.keys(), ...credited.keys()])].sort();
    const result = days.map((day) => {
      const entry = totals.get(day);
      return {
        day,
        balanceSum: entry && entry.balanceAccounts > 0 ? round2(entry.balanceSum) : null,
        balanceAccounts: entry?.balanceAccounts ?? 0,
        spentSum: entry && entry.spentAccounts > 0 ? round2(entry.spentSum) : null,
        spentAccounts: entry?.spentAccounts ?? 0,
        creditedSum: round2(credited.get(day) ?? 0),
      };
    });
    const limit = options.days === undefined ? result.length : Math.max(0, Math.floor(options.days));
    return limit >= result.length ? result : result.slice(result.length - limit);
  } finally {
    db.close();
  }
}

/** 供报表使用的时间序列：每个账号按时间正序的余额点。 */
export function balanceSeries(
  file: string = DEFAULT_DB_FILE,
): { alias: string; points: { time: string; balance: number }[] }[] {
  const db = openDatabase(file);
  try {
    const rows = db.prepare(`
      SELECT alias, time, balance_after
      FROM checkins
      WHERE balance_after IS NOT NULL
      ORDER BY alias, time, id
    `).all() as Record<string, unknown>[];
    const byAlias = new Map<string, { time: string; balance: number }[]>();
    for (const row of rows) {
      const alias = row.alias as string;
      if (!byAlias.has(alias)) byAlias.set(alias, []);
      byAlias.get(alias)!.push({ time: row.time as string, balance: row.balance_after as number });
    }
    return [...byAlias.entries()].map(([alias, points]) => ({ alias, points }));
  } finally {
    db.close();
  }
}


