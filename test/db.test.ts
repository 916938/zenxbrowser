import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  balanceSeries,
  DEFAULT_DB_FILE,
  insertCheckin,
  insertSnapshot,
  lastBalanceBefore,
  listCheckins,
  summarizeAccounts,
} from "../src/db.ts";
import type { CheckinRecord } from "../src/db.ts";

function tempDb(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "zenx-db-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "nested", "checkin.db");
}

const record = (overrides: Partial<CheckinRecord> = {}): CheckinRecord => ({
  time: "2026-09-16T04:00:00.000Z",
  alias: "edge-1",
  instanceId: "a82b44ca",
  identity: "github_236536",
  ok: true,
  balanceBefore: 1425,
  balanceAfter: 1450,
  credited: true,
  errorCode: null,
  ...overrides,
});

test("db 默认路径在项目根 zenxbrowser/ 下，不随工作目录变化", () => {
  assert.ok(/zenxbrowser[\\/]checkin\.db$/.test(DEFAULT_DB_FILE), DEFAULT_DB_FILE);
});

test("db 插入与查询往返，字段完整保留", (t) => {
  const file = tempDb(t);
  insertCheckin(record(), file);
  const rows = listCheckins({}, file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alias, "edge-1");
  assert.equal(rows[0].identity, "github_236536");
  assert.equal(rows[0].instanceId, "a82b44ca");
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].balanceBefore, 1425);
  assert.equal(rows[0].balanceAfter, 1450);
  assert.equal(rows[0].credited, true);
  assert.equal(rows[0].errorCode, null);
  assert.equal(rows[0].time, "2026-09-16T04:00:00.000Z");
  assert.equal(typeof rows[0].id, "number");
});

test("db 余额缺失存 NULL，不写成 0", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ balanceBefore: null, balanceAfter: null }), file);
  const row = listCheckins({}, file)[0];
  assert.equal(row.balanceBefore, null);
  assert.equal(row.balanceAfter, null);
});

test("db 失败记录保留错误码且 ok/credited 为 false", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ ok: false, credited: false, balanceBefore: null, balanceAfter: null, errorCode: "LOGIN_TIMEOUT" }), file);
  const row = listCheckins({}, file)[0];
  assert.equal(row.ok, false);
  assert.equal(row.credited, false);
  assert.equal(row.errorCode, "LOGIN_TIMEOUT");
});

test("db 重复打开建表幂等，连续写入不丢记录", (t) => {
  const file = tempDb(t);
  for (let i = 0; i < 5; i++) insertCheckin(record({ time: `2026-09-1${i}T04:00:00.000Z` }), file);
  assert.equal(listCheckins({}, file).length, 5);
});

test("db 按时间倒序返回，可按账号过滤", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ time: "2026-09-14T01:00:00Z", alias: "edge-1" }), file);
  insertCheckin(record({ time: "2026-09-16T01:00:00Z", alias: "edge-1" }), file);
  insertCheckin(record({ time: "2026-09-15T01:00:00Z", alias: "edge-2" }), file);

  const all = listCheckins({}, file);
  assert.deepEqual(all.map((r) => r.time), [
    "2026-09-16T01:00:00Z", "2026-09-15T01:00:00Z", "2026-09-14T01:00:00Z",
  ]);
  const filtered = listCheckins({ alias: "edge-1" }, file);
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((r) => r.alias === "edge-1"));
});

test("db limit 生效且被约束在合理范围", (t) => {
  const file = tempDb(t);
  for (let i = 0; i < 10; i++) insertCheckin(record({ time: `2026-09-${String(i + 1).padStart(2, "0")}T01:00:00Z` }), file);
  assert.equal(listCheckins({ limit: 3 }, file).length, 3);
  assert.equal(listCheckins({ limit: 0 }, file).length, 1, "limit 0 被抬升为 1");
  assert.equal(listCheckins({ limit: 999_999 }, file).length, 10);
});

test("db 汇总口径：累计到账只统计余额正增长", (t) => {
  const file = tempDb(t);
  // 首次签到 +25；当天重复签到 credited 但余额不变；一次失败。
  insertCheckin(record({ alias: "edge-5", identity: "github_136585", time: "2026-09-14T01:00:00Z", balanceBefore: 1208.7, balanceAfter: 1233.7 }), file);
  insertCheckin(record({ alias: "edge-5", identity: "github_136585", time: "2026-09-15T01:00:00Z", balanceBefore: 1233.7, balanceAfter: 1233.7 }), file);
  insertCheckin(record({ alias: "edge-5", identity: "github_136585", time: "2026-09-16T01:00:00Z", ok: false, credited: false, balanceBefore: null, balanceAfter: null, errorCode: "LOGIN_TIMEOUT" }), file);

  const [summary] = summarizeAccounts(file);
  assert.equal(summary.alias, "edge-5");
  assert.equal(summary.total, 3, "总次数含失败");
  assert.equal(summary.credited, 2, "重复签到计入成功次数");
  assert.equal(summary.totalGained, 25, "金额只统计实际增长");
  assert.equal(summary.currentBalance, 1233.7, "当前余额取最近一条非 NULL");
  assert.equal(summary.lastOk, false);
  assert.equal(summary.lastErrorCode, "LOGIN_TIMEOUT");
});

test("db 汇总：余额下降不计入累计到账", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ alias: "x", balanceBefore: 100, balanceAfter: 80, credited: false }), file);
  insertCheckin(record({ alias: "x", balanceBefore: 80, balanceAfter: 110, credited: true }), file);
  const [summary] = summarizeAccounts(file);
  assert.equal(summary.totalGained, 30, "只累加正增长部分");
});

test("db 汇总：多账号各自独立统计", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ alias: "edge-1", identity: "id1", balanceBefore: 100, balanceAfter: 125 }), file);
  insertCheckin(record({ alias: "edge-2", identity: "id2", balanceBefore: 200, balanceAfter: 225 }), file);
  const summaries = summarizeAccounts(file);
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map((s) => s.alias).sort(), ["edge-1", "edge-2"]);
  assert.ok(summaries.every((s) => s.totalGained === 25));
});

// 新账号往往只采集过快照（还没跑过 checkin），不能因为没签到记录就从汇总里消失——
// 报表里的"账号数"曾经因此停在过去的某个阶段。
test("db 汇总：只有快照没有签到记录的账号也计入，余额取快照", (t) => {
  const file = tempDb(t);
  insertSnapshot({ time: "2026-09-18T02:00:00.000Z", alias: "fresh", instanceId: "i", identity: "github_9", balance: 1187.41, totalSpent: 1412.59, ok: true, errorCode: null }, file);
  const [summary] = summarizeAccounts(file);
  assert.equal(summary.alias, "fresh");
  assert.equal(summary.identity, "github_9");
  assert.equal(summary.total, 0, "没有签到记录，次数为 0");
  assert.equal(summary.currentBalance, 1187.41);
  assert.equal(summary.balanceSource, "snapshot");
  assert.equal(summary.lastOk, null);
  assert.equal(summary.snapshots, 1);
});

test("db 汇总：余额取跨两张表的最近观测点", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ alias: "mix", balanceBefore: 100, balanceAfter: 125, time: "2026-09-18T02:00:00.000Z" }), file);
  insertSnapshot({ time: "2026-09-18T09:00:00.000Z", alias: "mix", instanceId: "i", identity: "id", balance: 200, totalSpent: 0, ok: true, errorCode: null }, file);
  const [summary] = summarizeAccounts(file);
  assert.equal(summary.currentBalance, 200, "快照晚于签到，应以快照为准");
  assert.equal(summary.balanceSource, "snapshot");
  assert.equal(summary.balanceTime, "2026-09-18T09:00:00.000Z");
  assert.equal(summary.totalGained, 25);
});

test("db 汇总：失败的签到不再把余额覆盖成未知", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ alias: "mix", balanceBefore: 100, balanceAfter: 125, time: "2026-09-18T02:00:00.000Z" }), file);
  insertCheckin(record({ alias: "mix", ok: false, credited: false, balanceBefore: null, balanceAfter: null, errorCode: "LOGIN_TIMEOUT", time: "2026-09-18T05:00:00.000Z" }), file);
  const [summary] = summarizeAccounts(file);
  assert.equal(summary.currentBalance, 125);
  assert.equal(summary.lastOk, false);
});

test("db 基准余额：没有签到记录时也能用快照建立发放前基准", (t) => {
  const file = tempDb(t);
  insertSnapshot({ time: "2026-09-18T02:00:00.000Z", alias: "fresh", instanceId: "i", identity: "id", balance: 900, totalSpent: 0, ok: true, errorCode: null }, file);
  assert.equal(lastBalanceBefore("fresh", "2026-09-19T00:00:00.000Z", file), 900);
  assert.equal(lastBalanceBefore("fresh", "2026-09-18T00:00:00.000Z", file), null);
});

// 站点"历史消耗"只在快照里读到，快照一旦停采，之后花掉的钱就没有观测点了。
// 实测 edge-1：最后一次快照停在 9/22（当时累计消耗 0），10 月靠签到记录花掉 674.59，
// 旧口径直接把最新快照的 0 当答案，账号汇总里显示成 -$0.00。
test("db 汇总：累计消耗 = 最新快照的站点累计值 + 快照之后签到反推的消耗", (t) => {
  const file = tempDb(t);
  insertSnapshot({
    time: "2026-09-22T13:07:40.000Z", alias: "edge-1", instanceId: "i",
    identity: "github_236536", balance: 1550, totalSpent: 0, ok: true, errorCode: null,
  }, file);
  // 快照之后：一路 +25（无消耗），直到 10/02 两次签到之间各掉一笔。
  const after = [
    ["2026-09-22T14:25:54.000Z", 1550, 1575],
    ["2026-09-24T15:40:43.000Z", 1575, 1600],
    ["2026-09-28T10:30:45.000Z", 1600, 1625],
    ["2026-09-30T06:29:03.000Z", 1625, 1650],
    ["2026-10-01T08:26:10.000Z", 1650, 1675],
    ["2026-10-02T10:58:21.000Z", 1621.79, 1646.79],   // 1675 + 25 − 1646.79 = 53.21
    ["2026-10-02T19:36:41.000Z", 1100.41, 1125.41],   // 1646.79 + 25 − 1125.41 = 546.38
  ] as const;
  for (const [time, balanceBefore, balanceAfter] of after) {
    insertCheckin(record({ time, balanceBefore, balanceAfter }), file);
  }

  const [summary] = summarizeAccounts(file);
  assert.equal(summary.totalSpent, 599.59, "快照的 0 加上快照之后的 53.21 + 546.38");
});

test("db 汇总：只有快照的账号，累计消耗就是快照读到的站点累计值", (t) => {
  const file = tempDb(t);
  insertSnapshot({
    time: "2026-09-22T13:07:40.000Z", alias: "fresh", instanceId: "i",
    identity: "github_9", balance: 900, totalSpent: 1412.59, ok: true, errorCode: null,
  }, file);
  const [summary] = summarizeAccounts(file);
  assert.equal(summary.totalSpent, 1412.59, "没有后续签到记录可反推，锚点值即答案");
});

// 近期消耗 = 现在的累计消耗 − 窗口起点的累计消耗，同源差分，所以不可能比累计还大。
// 曾经按"每日明细累加"实现过一次：快照稀疏时跨窗口的那一大笔会被重复计入，
// 实测 edge-1 算出 802.8 > 674.59，看着就像账本坏了。
test("db 汇总：近期消耗 = 窗口内累计消耗的增量，且不超过累计消耗", (t) => {
  const file = tempDb(t);
  const at = (daysAgo: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  };
  insertSnapshot({
    time: at(10), alias: "edge-1", instanceId: "i", identity: "github_1",
    balance: 1000, totalSpent: 0, ok: true, errorCode: null,
  }, file);
  // 窗口外：连着三天 +25，没有消耗。
  insertCheckin(record({ time: at(9), balanceBefore: 1000, balanceAfter: 1025 }), file);
  insertCheckin(record({ time: at(8), balanceBefore: 1025, balanceAfter: 1050 }), file);
  // 窗口内：先 +25，再在两次签到之间花掉 100。
  insertCheckin(record({ time: at(7), balanceBefore: 1050, balanceAfter: 1075 }), file);
  insertCheckin(record({ time: at(3), balanceBefore: 975, balanceAfter: 1000 }), file);
  insertCheckin(record({ time: at(1), balanceBefore: 1000, balanceAfter: 1025 }), file);

  const [summary] = summarizeAccounts(file);
  assert.equal(summary.totalSpent, 100, "累计消耗 = 快照锚点 0 + 反推出的 100");
  assert.equal(summary.recentSpent, 100, "这 100 全发生在窗口内");
  assert.ok(summary.recentSpent! <= summary.totalSpent!, "近期不可能超过累计");
});

// 窗口里一个观测点都没有时，差分必然是 0——但那是"没看到"，不是"没花钱"。
test("db 汇总：近期窗口内没有观测点时近期消耗为 null，不谎报 0", (t) => {
  const file = tempDb(t);
  const old = new Date();
  old.setDate(old.getDate() - 20);
  insertCheckin(record({ time: old.toISOString(), balanceBefore: 100, balanceAfter: 125 }), file);
  const [summary] = summarizeAccounts(file);
  assert.equal(summary.recentSpent, null, "20 天前的数据不能用来回答最近 7 天");
  assert.equal(summary.totalSpent, null, "只有一条观测点，无从反推消耗");
});

test("db 空库时汇总与列表返回空数组，不报错", (t) => {
  const file = tempDb(t);
  assert.deepEqual(summarizeAccounts(file), []);
  assert.deepEqual(listCheckins({}, file), []);
  assert.deepEqual(balanceSeries(file), []);
});

test("db 余额序列按账号分组、按时间正序，跳过 NULL 余额", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ alias: "edge-1", time: "2026-09-16T01:00:00Z", balanceAfter: 200 }), file);
  insertCheckin(record({ alias: "edge-1", time: "2026-09-14T01:00:00Z", balanceAfter: 100 }), file);
  insertCheckin(record({ alias: "edge-1", time: "2026-09-15T01:00:00Z", balanceAfter: null }), file);
  insertCheckin(record({ alias: "edge-2", time: "2026-09-14T01:00:00Z", balanceAfter: 50 }), file);

  const series = balanceSeries(file);
  assert.equal(series.length, 2);
  const first = series.find((s) => s.alias === "edge-1");
  assert.deepEqual(first?.points, [
    { time: "2026-09-14T01:00:00Z", balance: 100 },
    { time: "2026-09-16T01:00:00Z", balance: 200 },
  ]);
});

test("db 中文身份正确存储与读取", (t) => {
  const file = tempDb(t);
  insertCheckin(record({ identity: "用户_张三" }), file);
  assert.equal(listCheckins({}, file)[0].identity, "用户_张三");
});

test("db 独立实例互不干扰", (t) => {
  const a = tempDb(t);
  const b = join(mkdtempSync(join(tmpdir(), "zenx-db-b-")), `x${randomUUID()}.db`);
  insertCheckin(record({ alias: "only-a" }), a);
  assert.equal(listCheckins({}, a).length, 1);
  assert.equal(listCheckins({}, b).length, 0);
});
