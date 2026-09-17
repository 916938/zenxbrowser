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
