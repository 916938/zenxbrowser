import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dailyTotals, insertCheckin, listSnapshots, rangeSummary } from "../src/db.ts";
import { snapshotAccount, snapshotAll } from "../src/snapshot.ts";
import type { Browser, Runner } from "../src/core.ts";

const edge: Browser = {
  instance_id: "1234abcd", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "工作账号", extension_protocol_version: "1.1", version_skew: false,
};
const account = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "github_16350", boundAt: "2026-09-13T09:32:45.124Z" };

const LOGGED_IN = "Agent Router 控制台 数据看板 当前余额 $1100.00 历史消耗 $125.00 G github_16350 chevron_down";
const LOGGED_OUT = "Agent Router 登录 注册 登 录 使用 GitHub 继续";

function runner(options: { text?: string; browsers?: Browser[]; calls?: string[][] } = {}): Runner {
  return async (args) => {
    options.calls?.push(args);
    if (args[0] === "browsers") return { stdout: JSON.stringify(options.browsers ?? [edge]), exitCode: 0 };
    if (args[0] === "session" && args[1] === "start") return { stdout: JSON.stringify({ session_id: "abcd" }), exitCode: 0 };
    if (args[0] === "session" && args[1] === "stop") return { stdout: "", exitCode: 0 };
    if (args[0] === "navigate") return { stdout: "", exitCode: 0 };
    if (args[0] === "evaluate") return { stdout: JSON.stringify({ ok: true, tab_id: 7, value: options.text ?? "" }), exitCode: 0 };
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }, accounts = [account]) {
  const home = await mkdtemp(join(tmpdir(), "zenx-snapshot-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts }));
  return { home, dbFile: join(home, "checkin.db") };
}

const fast = { sleep: async () => {} };

test("快照写入余额与站点累计消耗", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await snapshotAccount(home, runner({ text: LOGGED_IN }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.balance, 1100);
  assert.equal(result.totalSpent, 125);
  const rows = listSnapshots({ alias: account.alias }, dbFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance, 1100);
  assert.equal(rows[0].totalSpent, 125);
  assert.equal(rows[0].ok, true);
});

test("英文界面的账号也能读出余额与累计消耗", async (t) => {
  const { home, dbFile } = await temporary(t);
  // Real page text from an account whose site UI renders in English.
  const english = "Agent Router Home Console Docs 15 G github_16350 CONSOLE Dashboard " +
    "Account Data Current balance $1187.41 Consumption $1412.59 Usage Statistics";
  const result = await snapshotAccount(home, runner({ text: english }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.balance, 1187.41);
  assert.equal(result.totalSpent, 1412.59);
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].totalSpent, 1412.59);
});

test("未登录也写快照并记失败原因", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await snapshotAccount(home, runner({ text: LOGGED_OUT }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "LOGGED_OUT");
  const rows = listSnapshots({ alias: account.alias }, dbFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].errorCode, "LOGGED_OUT");
});

test("身份不符时写失败快照，不记录余额", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await snapshotAccount(home, runner({ text: "控制台 当前余额 $900.00 G github_99999 chevron_down" }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.errorCode, "IDENTITY_MISMATCH");
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].balance, 900);
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].ok, false);
});

test("离线时不开窗口，只留失败快照", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  const result = await snapshotAccount(home, runner({ browsers: [], calls }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.connection, "offline");
  assert.equal(result.errorCode, "OFFLINE");
  assert.ok(!calls.some((args) => args[0] === "session"));
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].errorCode, "OFFLINE");
});

test("批量采集：单个账号失败不中断，汇总如实计数", async (t) => {
  const second = { ...account, alias: "broken", instanceId: "eeee9999", expectedIdentity: "github_1" };
  const { home, dbFile } = await temporary(t, [account, second]);
  const result = await snapshotAll(home, runner({ text: LOGGED_IN }), 45_000, { dbFile, ...fast });
  assert.equal(result.total, 2);
  assert.equal(result.saved, 1);
  assert.equal(result.ok, false);
  assert.equal(result.results.find((item) => item.alias === "broken")?.errorCode, "OFFLINE");
  assert.equal(listSnapshots({}, dbFile).length, 2);
});

test("区间汇总：到账按余额增长计，消耗按累计消耗差分", async (t) => {
  const { home, dbFile } = await temporary(t);
  const day = 86_400_000;
  const yesterday = new Date(Date.now() - day).toISOString();
  const today = new Date().toISOString();
  insertCheckin({ time: today, alias: account.alias, instanceId: account.instanceId, identity: account.expectedIdentity, ok: true, balanceBefore: 1000, balanceAfter: 1025, credited: true, errorCode: null }, dbFile);
  const snapshot = (time: string, balance: number, totalSpent: number) => ({
    time, alias: account.alias, instanceId: account.instanceId, identity: account.expectedIdentity,
    balance, totalSpent, ok: true, errorCode: null,
  });
  const { insertSnapshot } = await import("../src/db.ts");
  insertSnapshot(snapshot(yesterday, 1000, 100), dbFile);
  insertSnapshot(snapshot(today, 1100, 125), dbFile);

  const start = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const end = new Date(new Date().setHours(24, 0, 0, 0)).toISOString();
  const [row] = rangeSummary(start, end, dbFile);
  assert.equal(row.alias, account.alias);
  assert.equal(row.credited, 25);
  assert.equal(row.spent, 25);
  assert.equal(row.balanceEnd, 1100);
  assert.equal(row.checkins, 1);
  assert.equal(row.checkinsOk, 1);
  assert.equal(row.snapshots, 1);

  const [before] = rangeSummary(new Date(Date.now() - 2 * day).toISOString(), start, dbFile);
  assert.equal(before.spent, 0);  // 前一天没有更早的观测点，只能与自己比
  assert.equal(before.credited, 0);
});

test("区间内没有快照时消耗为 null，不臆造", async (t) => {
  const { home, dbFile } = await temporary(t);
  insertCheckin({ time: new Date().toISOString(), alias: account.alias, instanceId: account.instanceId, identity: account.expectedIdentity, ok: true, balanceBefore: 100, balanceAfter: 125, credited: true, errorCode: null }, dbFile);
  const start = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const [row] = rangeSummary(start, new Date(new Date().setHours(24, 0, 0, 0)).toISOString(), dbFile);
  assert.equal(row.credited, 25);
  assert.equal(row.spent, null);
  assert.equal(row.snapshots, 0);
});

test("每日总额：余额合计、消耗合计、到账合计与覆盖账号数", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { insertSnapshot } = await import("../src/db.ts");
  const day = 86_400_000;
  const yesterday = new Date(Date.now() - day).toISOString();
  const today = new Date().toISOString();
  const snap = (time: string, alias: string, balance: number, spent: number) => ({
    time, alias, instanceId: "inst", identity: "id", balance, totalSpent: spent, ok: true, errorCode: null,
  });
  insertSnapshot(snap(yesterday, "work", 100, 50), dbFile);
  insertSnapshot(snap(today, "work", 125, 70), dbFile);
  insertSnapshot(snap(yesterday, "second", 200, 10), dbFile);
  insertSnapshot(snap(today, "second", 225, 30), dbFile);
  insertCheckin({ time: today, alias: "work", instanceId: "inst", identity: "id", ok: true, balanceBefore: 100, balanceAfter: 125, credited: true, errorCode: null }, dbFile);
  insertCheckin({ time: today, alias: "second", instanceId: "inst", identity: "id", ok: true, balanceBefore: 200, balanceAfter: 225, credited: true, errorCode: null }, dbFile);

  const rows = dailyTotals({}, dbFile);
  assert.equal(rows.length, 2);
  const last = rows[rows.length - 1];
  const first = rows[rows.length - 2];
  assert.equal(last.balanceSum, 350);
  assert.equal(last.balanceAccounts, 2);
  assert.equal(last.balanceStaleAccounts, 0, "当天都有观测点");
  assert.equal(last.spentSum, 40);           // (70-50) + (30-10)
  assert.equal(last.spentAccounts, 2);
  assert.equal(last.creditedSum, 50, "到账优先取签到记录里的余额真实增长");
  assert.equal(last.creditedAccounts, 2);
  assert.equal(first.balanceSum, 300);
  assert.equal(first.spentSum, null);        // 没有更早的观测点，不臆造消耗
  assert.equal(first.spentAccounts, 0);
  assert.equal(dailyTotals({ days: 1 }, dbFile).length, 1);
});

// 昨天 5 个账号的真实场景：checkin 记录是 LOGIN_TIMEOUT（失败、余额为 NULL），
// 但额度后来靠 zenx accounts login 登录发放并体现在快照里。账本不能因为它们
// 没有走 checkin 路径就把领到的钱抹掉，所以用快照反推到账（到账 = Δ余额 + Δ消耗）。
test("每日总额：签到记录失败但快照显示已发放时，按快照反推到账，不重复计数", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { insertSnapshot } = await import("../src/db.ts");
  const day = 86_400_000;
  const yesterday = new Date(Date.now() - day).toISOString();
  const today = new Date().toISOString();
  const snap = (time: string, alias: string, balance: number, spent: number) => ({
    time, alias, instanceId: "inst", identity: "id", balance, totalSpent: spent, ok: true, errorCode: null,
  });
  insertSnapshot(snap(yesterday, "recovered", 1000, 100), dbFile);
  insertSnapshot(snap(today, "recovered", 1025, 110), dbFile);       // Δ余额 25 + Δ消耗 10 = 到账 35
  insertSnapshot(snap(today, "plain", 500, 20), dbFile);
  insertSnapshot(snap(yesterday, "plain", 500, 20), dbFile);
  insertCheckin({ time: today, alias: "recovered", instanceId: "inst", identity: "id", ok: false, balanceBefore: null, balanceAfter: null, credited: false, errorCode: "LOGIN_TIMEOUT" }, dbFile);
  insertCheckin({ time: today, alias: "plain", instanceId: "inst", identity: "id", ok: true, balanceBefore: 500, balanceAfter: 525, credited: true, errorCode: null }, dbFile);

  const [row] = dailyTotals({ days: 1 }, dbFile);
  assert.equal(row.creditedSum, 60, "recovered 用快照反推（35），plain 用签到记录（25）");
  assert.equal(row.creditedAccounts, 2);
  assert.equal(row.balanceSum, 1525);
  assert.equal(row.balanceAccounts, 2);
  assert.equal(row.balanceStaleAccounts, 0);
});

// 窗口隐藏时页面渲染不出余额，站点会显示 0（实测）。把它当真值会让"当日到账"
// 凭空多出一千多（0 → 1175 被算成到账）。
test("每日总额：余额读到 0 视为缺失，不制造假到账", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { insertSnapshot } = await import("../src/db.ts");
  const day = 86_400_000;
  const earlier = new Date(Date.now() - 2 * day).toISOString();
  const yesterday = new Date(Date.now() - day).toISOString();
  const today = new Date().toISOString();
  const snap = (time: string, balance: number) => ({
    time, alias: account.alias, instanceId: "inst", identity: "id", balance, totalSpent: 0, ok: true, errorCode: null,
  });
  insertSnapshot(snap(earlier, 1175), dbFile);
  insertSnapshot(snap(yesterday, 0), dbFile);      // 页面没渲染出来
  insertSnapshot(snap(today, 1175), dbFile);
  const rows = dailyTotals({}, dbFile);
  const last = rows[rows.length - 1];
  assert.equal(last.creditedSum, 0, "0 不能当成真余额");
  assert.equal(last.balanceSum, 1175);
  assert.equal(last.balanceAccounts, 1);
});

test("每日总额：同一天多次采集以最后一次为准", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { insertSnapshot } = await import("../src/db.ts");
  const base = new Date().toISOString();
  const later = new Date(Date.now() + 60_000).toISOString();
  const snap = (time: string, balance: number, spent: number) => ({
    time, alias: account.alias, instanceId: "inst", identity: "id", balance, totalSpent: spent, ok: true, errorCode: null,
  });
  insertSnapshot(snap(base, 100, 10), dbFile);
  insertSnapshot(snap(later, 150, 10), dbFile);
  const [row] = dailyTotals({ days: 1 }, dbFile);
  assert.equal(row.balanceSum, 150);
  assert.equal(row.balanceAccounts, 1);
});

test("CLI：snapshot 单账号与 --all", async (t) => {
  const { home, dbFile } = await temporary(t);
  const lines: string[] = [];
  assert.equal(await main(["accounts", "snapshot", account.alias, "--json"], { home, run: runner({ text: LOGGED_IN }), snapshotDbFile: dbFile, output: (line) => lines.push(line) }), 0);
  assert.equal(JSON.parse(lines[0]).balance, 1100);

  const all: string[] = [];
  assert.equal(await main(["accounts", "snapshot", "--all", "--json"], { home, run: runner({ text: LOGGED_IN }), snapshotDbFile: dbFile, output: (line) => all.push(line) }), 0);
  const report = JSON.parse(all[0]);
  assert.equal(report.total, 1);
  assert.equal(report.saved, 1);
  assert.equal(listSnapshots({}, dbFile).length, 2);
});

test("CLI：--all 与别名互斥，且不接受签到参数", async (t) => {
  const { home, dbFile } = await temporary(t);
  const lines: string[] = [];
  assert.equal(await main(["accounts", "snapshot", "--all", account.alias, "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => lines.push(line) }), 1);
  assert.match(lines[0], /--all 会采集全部账号/);
  const other: string[] = [];
  assert.equal(await main(["accounts", "snapshot", account.alias, "--force", "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => other.push(line) }), 1);
  assert.match(other[0], /INVALID_ARGUMENT/);
});
