import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SITE, baseAliasOf, ledgerAliasOf, siteOfAlias,
  dailyTotals, insertCheckin, insertSnapshot, summarizeAccounts, balanceSeries,
} from "../src/db.ts";

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "zenx-site-split-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "checkin.db");
}

// ---------------------------------------------------------------------------
// 账本 alias 的站点约定
// ---------------------------------------------------------------------------

test("alias 与站点互转", () => {
  assert.equal(DEFAULT_SITE, "agentrouter");
  assert.equal(siteOfAlias("edge-6"), "agentrouter");
  assert.equal(siteOfAlias("edge-6@anyrouter"), "anyrouter");
  assert.equal(baseAliasOf("edge-6@anyrouter"), "edge-6");
  assert.equal(baseAliasOf("edge-6"), "edge-6");
  assert.equal(ledgerAliasOf("edge-6", "agentrouter"), "edge-6", "默认站点不加后缀，历史记录不变");
  assert.equal(ledgerAliasOf("edge-6", "anyrouter"), "edge-6@anyrouter");
});

test("带 @ 的站点 id 不会被误切", () => {
  // alias 本身不含 @，只按最后一个 @ 切分
  assert.equal(siteOfAlias("edge-6@anyrouter@x"), "x");
  assert.equal(baseAliasOf("edge-6@anyrouter@x"), "edge-6@anyrouter");
});

// ---------------------------------------------------------------------------
// 汇总：两个站点的账号互不干扰
// ---------------------------------------------------------------------------

test("同一 Profile 在两站的记录分别汇总，不互相覆盖", async (t) => {
  const dbFile = await temporary(t);
  const now = new Date().toISOString();
  // edge-6 在 AgentRouter：余额 1276.60
  insertCheckin({ time: now, alias: "edge-6", instanceId: "i", identity: "github_206707",
    ok: true, balanceBefore: 1251.6, balanceAfter: 1276.6, credited: true, errorCode: null }, dbFile);
  // edge-6 在 AnyRouter：完全不同的站点账号与余额
  insertCheckin({ time: now, alias: "edge-6@anyrouter", instanceId: "i", identity: "linuxdo_85789",
    ok: true, balanceBefore: null, balanceAfter: 5121.77, credited: false, errorCode: null }, dbFile);

  const sum = summarizeAccounts(dbFile);
  assert.equal(sum.length, 2);
  const ar = sum.find((s) => s.alias === "edge-6");
  const any = sum.find((s) => s.alias === "edge-6@anyrouter");
  assert.equal(ar?.currentBalance, 1276.6);
  assert.equal(ar?.identity, "github_206707");
  assert.equal(any?.currentBalance, 5121.77);
  assert.equal(any?.identity, "linuxdo_85789");
});

// ---------------------------------------------------------------------------
// 每日总额：按站点拆分
// ---------------------------------------------------------------------------

function dayAt(offsetDays: number, hour = 12): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test("dailyTotals 按站点给出各自的余额合计，不相加", async (t) => {
  const dbFile = await temporary(t);
  const t0 = dayAt(1);
  insertSnapshot({ time: t0, alias: "edge-6", instanceId: "i", identity: "github_206707",
    balance: 1000, totalSpent: 500, ok: true, errorCode: null }, dbFile);
  insertSnapshot({ time: t0, alias: "edge-6@anyrouter", instanceId: "i", identity: "linuxdo_85789",
    balance: 5000, totalSpent: 100, ok: true, errorCode: null }, dbFile);

  const daily = dailyTotals({}, dbFile);
  const day = daily[daily.length - 1];
  assert.ok(day.bySite, "必须有 bySite");
  // 两个站点各自一行，不是相加成 6000
  assert.equal(day.bySite.agentrouter.balanceSum, 1000);
  assert.equal(day.bySite.anyrouter.balanceSum, 5000);
  assert.equal(day.bySite.agentrouter.balanceAccounts, 1);
  assert.equal(day.bySite.anyrouter.balanceAccounts, 1);
  // 顶层仍保留跨站点合计（历史口径），但报表不展示它
  assert.equal(day.balanceSum, 6000);
});

test("dailyTotals 的到账按站点归类", async (t) => {
  const dbFile = await temporary(t);
  const t0 = dayAt(0, 10);
  // AgentRouter 签到到账 +25
  insertCheckin({ time: t0, alias: "edge-6", instanceId: "i", identity: "github_206707",
    ok: true, balanceBefore: 1000, balanceAfter: 1025, credited: true, errorCode: null }, dbFile);
  // AnyRouter 同日刷新，余额不变（当天已签过）
  insertCheckin({ time: t0, alias: "edge-p16@anyrouter", instanceId: "i", identity: "linuxdo_85219",
    ok: true, balanceBefore: null, balanceAfter: 5037.06, credited: false, errorCode: null }, dbFile);

  const daily = dailyTotals({}, dbFile);
  const day = daily[daily.length - 1];
  assert.equal(day.bySite.agentrouter.creditedSum, 25);
  assert.equal(day.bySite.anyrouter.creditedSum, 0, "AnyRouter 当天没有余额增长，不计到账");
});

test("只有单一站点时不产生空站点条目", async (t) => {
  const dbFile = await temporary(t);
  insertSnapshot({ time: dayAt(0), alias: "edge-6", instanceId: "i", identity: "github_206707",
    balance: 1000, totalSpent: 500, ok: true, errorCode: null }, dbFile);
  const daily = dailyTotals({}, dbFile);
  const day = daily[daily.length - 1];
  assert.deepEqual(Object.keys(day.bySite), ["agentrouter"]);
});

test("消耗按站点拆分：只统计本站点账号的消耗", async (t) => {
  const dbFile = await temporary(t);
  const before = dayAt(2), after = dayAt(1);
  // AgentRouter：历史消耗 500 → 600（花 100）
  insertSnapshot({ time: before, alias: "edge-6", instanceId: "i", identity: "github_206707",
    balance: 1000, totalSpent: 500, ok: true, errorCode: null }, dbFile);
  insertSnapshot({ time: after, alias: "edge-6", instanceId: "i", identity: "github_206707",
    balance: 900, totalSpent: 600, ok: true, errorCode: null }, dbFile);
  // AnyRouter：历史消耗 100 → 130（花 30）
  insertSnapshot({ time: before, alias: "edge-6@anyrouter", instanceId: "i", identity: "linuxdo_85789",
    balance: 5000, totalSpent: 100, ok: true, errorCode: null }, dbFile);
  insertSnapshot({ time: after, alias: "edge-6@anyrouter", instanceId: "i", identity: "linuxdo_85789",
    balance: 4970, totalSpent: 130, ok: true, errorCode: null }, dbFile);

  const daily = dailyTotals({}, dbFile);
  const day = daily[daily.length - 1];
  assert.equal(day.bySite.agentrouter.spentSum, 100);
  assert.equal(day.bySite.anyrouter.spentSum, 30);
});

// ---------------------------------------------------------------------------
// 趋势图数据：两站的序列分开，互不混淆
// ---------------------------------------------------------------------------

test("balanceSeries 保留各自的 alias，报表据此分图", async (t) => {
  const dbFile = await temporary(t);
  const now = new Date().toISOString();
  insertCheckin({ time: now, alias: "edge-6", instanceId: "i", identity: "github_206707",
    ok: true, balanceBefore: null, balanceAfter: 1000, credited: false, errorCode: null }, dbFile);
  insertCheckin({ time: now, alias: "edge-6@anyrouter", instanceId: "i", identity: "linuxdo_85789",
    ok: true, balanceBefore: null, balanceAfter: 5000, credited: false, errorCode: null }, dbFile);

  const series = balanceSeries(dbFile);
  assert.equal(series.length, 2);
  assert.ok(series.some((s) => s.alias === "edge-6" && s.points[0].balance === 1000));
  assert.ok(series.some((s) => s.alias === "edge-6@anyrouter" && s.points[0].balance === 5000));
});
