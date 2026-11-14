import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dailyTotals, insertCheckin, listSnapshots, rangeSummary } from "../src/db.ts";
import { snapshotAccount, snapshotAll, snapshotMissing } from "../src/snapshot.ts";
import { readLeftovers } from "../src/leftover.ts";
import type { LaunchDependencies } from "../src/launch.ts";
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

/**
 * 取单站点结果。snapshotAccount 现在按站点返回数组（一个 Profile 可能在多个站点
 * 各有身份），这些 fixture 账号只绑了 AgentRouter 身份，所以恒为一条。
 */
async function snapshotOne(...args: Parameters<typeof snapshotAccount>) {
  const results = await snapshotAccount(...args);
  assert.equal(results.length, 1, "只绑了 AgentRouter 身份，应当只有一条结果");
  return results[0];
}

test("快照写入余额与站点累计消耗", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await snapshotOne(home, runner({ text: LOGGED_IN }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.site, "agentrouter");
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
  const result = await snapshotOne(home, runner({ text: english }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.balance, 1187.41);
  assert.equal(result.totalSpent, 1412.59);
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].totalSpent, 1412.59);
});

test("未登录也写快照并记失败原因", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await snapshotOne(home, runner({ text: LOGGED_OUT }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "LOGGED_OUT");
  const rows = listSnapshots({ alias: account.alias }, dbFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].errorCode, "LOGGED_OUT");
});

test("身份不符时写失败快照，不记录余额", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await snapshotOne(home, runner({ text: "控制台 当前余额 $900.00 G github_99999 chevron_down" }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.errorCode, "IDENTITY_MISMATCH");
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].balance, 900);
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].ok, false);
});

test("离线时不开窗口，只留失败快照", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  const result = await snapshotOne(home, runner({ browsers: [], calls }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.connection, "offline");
  assert.equal(result.errorCode, "OFFLINE");
  assert.ok(!calls.some((args) => args[0] === "session"));
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].errorCode, "OFFLINE");
  // 没配启动路径时不再只丢一句"实例离线"，要直接给出可执行的下一步。
  assert.match(result.note ?? "", /configure-launch/);
  assert.match(result.hint ?? "", /configure-launch/);
  assert.equal(result.launched, false);
});

test("页面读到 $0 时视为未渲染，快照记 null 而不是 0", async (t) => {
  const { home, dbFile } = await temporary(t);
  // 窗口被遮挡/后台时页面渲染不出余额，站点给 $0 这类占位读数。
  // 0 若被当成真值，报表会把"隐藏窗口"当成"余额归零"，制造假到账/假归零。
  const result = await snapshotOne(home, runner({ text: "控制台 当前余额 $0 历史消耗 $0 G github_16350 chevron_down" }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.balance, null, "0 不是可用的余额读数");
  assert.equal(result.totalSpent, 0, "消耗 0 是合法读数，站点确实没有消耗");
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].balance, null);
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

// 快照缺失时消耗由签到记录反推：上次余额 + 25 − 本次余额。
// 快照的"历史消耗"需要每天跑 snapshot 才有观测点；签到记录每天都有，作为兜底。
test("每日总额：快照缺失时由签到记录反推消耗", async (t) => {
  const { home, dbFile } = await temporary(t);
  const day = 86_400_000;
  const yesterday = new Date(Date.now() - day).toISOString();
  const today = new Date().toISOString();
  insertCheckin({ time: yesterday, alias: account.alias, instanceId: "inst", identity: "id", ok: true, balanceBefore: 1000, balanceAfter: 1025, credited: true, errorCode: null }, dbFile);
  insertCheckin({ time: today, alias: account.alias, instanceId: "inst", identity: "id", ok: true, balanceBefore: 1010, balanceAfter: 1035, credited: true, errorCode: null }, dbFile);

  const rows = dailyTotals({}, dbFile);
  const last = rows[rows.length - 1];
  // 昨日余额 1025 + 额度 25 − 今日余额 1035 = 消耗 15
  assert.equal(last.spentSum, 15);
  assert.equal(last.spentAccounts, 1);
});

// 既有快照又有签到记录时，快照优先，不重复计数。
test("每日总额：快照与签到并存时消耗不重复计数", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { insertSnapshot } = await import("../src/db.ts");
  const day = 86_400_000;
  const yesterday = new Date(Date.now() - day).toISOString();
  const today = new Date().toISOString();
  const snap = (time: string, balance: number, spent: number) => ({
    time, alias: account.alias, instanceId: "inst", identity: "id", balance, totalSpent: spent, ok: true, errorCode: null,
  });
  insertSnapshot(snap(yesterday, 1000, 50), dbFile);
  insertSnapshot(snap(today, 1025, 70), dbFile);
  insertCheckin({ time: yesterday, alias: account.alias, instanceId: "inst", identity: "id", ok: true, balanceBefore: 1000, balanceAfter: 1025, credited: true, errorCode: null }, dbFile);
  insertCheckin({ time: today, alias: account.alias, instanceId: "inst", identity: "id", ok: true, balanceBefore: 1000, balanceAfter: 1025, credited: true, errorCode: null }, dbFile);

  const rows = dailyTotals({}, dbFile);
  const last = rows[rows.length - 1];
  // 快照口径：70 - 50 = 20；签到口径：1025 + 25 - 1025 = 25。快照优先，只算 20。
  assert.equal(last.spentSum, 20);
  assert.equal(last.spentAccounts, 1);
});

test("CLI：snapshot 单账号与 --all", async (t) => {
  const { home, dbFile } = await temporary(t);
  const lines: string[] = [];
  assert.equal(await main(["accounts", "snapshot", account.alias, "--json"], { home, run: runner({ text: LOGGED_IN }), snapshotDbFile: dbFile, output: (line) => lines.push(line) }), 0);
  // 单账号报告按站点分条：只绑了 AgentRouter，所以恰好一条。
  const single = JSON.parse(lines[0]);
  assert.equal(single.ok, true);
  assert.equal(single.total, 1);
  assert.equal(single.results[0].site, "agentrouter");
  assert.equal(single.results[0].balance, 1100);

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

// --missing 回答"今天还差谁"。自动快照已随签到落下（见 checkin.ts 的 finish），
// 日常脚本靠这个只读清单补漏，而不是整轮重采——整轮重采在关窗之后只会采到 OFFLINE。
test("CLI：snapshot --missing 只读账本，不碰 bsk 也不拉起 Edge", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  const lines: string[] = [];
  const code = await main(["accounts", "snapshot", "--missing", "--json"], {
    home, run: runner({ calls }), snapshotDbFile: dbFile, output: (line) => lines.push(line),
  });
  const report = JSON.parse(lines[0]);
  assert.equal(report.ok, false, "一条快照都没有，覆盖率不达标");
  assert.deepEqual(report.missing, [account.alias]);
  assert.equal(report.total, 1);
  assert.equal(report.saved, 0);
  assert.equal(code, 1, "有缺失时退出码非 0，脚本才能据此补采");
  assert.deepEqual(calls, [], "只读账本：一次 bsk 都不该调");
});

test("CLI：snapshot --missing 认同一时点的配对快照，已采的不再报缺", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { insertSnapshot } = await import("../src/db.ts");
  const now = new Date();
  // 签到时就地采的那种：余额与累计消耗同源，且是当天最新的余额观测点。
  insertSnapshot({
    time: now.toISOString(), alias: account.alias, instanceId: account.instanceId,
    identity: account.expectedIdentity, balance: 1100, totalSpent: 125, ok: true, errorCode: null,
  }, dbFile);
  const lines: string[] = [];
  const code = await main(["accounts", "snapshot", "--missing", "--json"], {
    home, run: runner(), snapshotDbFile: dbFile, output: (line) => lines.push(line), now: () => now,
  });
  const report = JSON.parse(lines[0]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.missing, []);
  assert.equal(report.saved, 1);
  assert.equal(code, 0);
});

// 只有余额、没有累计消耗的快照不算配对：Δ消耗基准配不上，判定会退化为裸余额差。
test("CLI：snapshot --missing 不把缺消耗的快照当成已采集", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { insertSnapshot } = await import("../src/db.ts");
  const now = new Date();
  insertSnapshot({
    time: now.toISOString(), alias: account.alias, instanceId: account.instanceId,
    identity: account.expectedIdentity, balance: 1100, totalSpent: null, ok: true, errorCode: null,
  }, dbFile);
  const lines: string[] = [];
  await main(["accounts", "snapshot", "--missing", "--json"], {
    home, run: runner(), snapshotDbFile: dbFile, output: (line) => lines.push(line), now: () => now,
  });
  assert.deepEqual(JSON.parse(lines[0]).missing, [account.alias], "缺消耗就不是可用基准");
});

test("CLI：snapshot --missing 不接受别名，也不与 --all 同用", async (t) => {
  const { home, dbFile } = await temporary(t);
  const withAlias: string[] = [];
  assert.equal(await main(["accounts", "snapshot", "--missing", account.alias, "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => withAlias.push(line) }), 1);
  assert.match(withAlias[0], /--missing 只读账本/);
  const withAll: string[] = [];
  assert.equal(await main(["accounts", "snapshot", "--missing", "--all", "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => withAll.push(line) }), 1);
  assert.match(withAll[0], /不能同时使用/);
});

// ---- 离线自动拉起：不用再手工提前打开浏览器 ----

type AutoState = { online: Browser[]; launched: number; closed: number; calls: string[][] };

/** 造出能通过 validatePaths 的启动配置；Edge 启动本身由替身接管，不会真的开进程。 */
async function launchFixture(t: { after: (fn: () => Promise<void>) => void }, accounts = [account]) {
  const { home, dbFile } = await temporary(t, accounts);
  const edgePath = join(home, "msedge.exe");
  const userDataDir = join(home, "User Data");
  await writeFile(edgePath, "fake executable");
  const store = JSON.parse(await readFile(join(home, "accounts.json"), "utf8"));
  for (const [index, item] of store.accounts.entries()) {
    // 每个账号独立 Profile：共享同一个会被 rejectSharedProfile 拒绝。
    const profileDirectory = `Profile ${index + 1}`;
    await mkdir(join(userDataDir, profileDirectory), { recursive: true });
    await writeFile(join(userDataDir, profileDirectory, "Preferences"), "{}");
    item.launch = { edgePath, userDataDir, profileDirectory };
  }
  await writeFile(join(home, "accounts.json"), JSON.stringify(store));
  return { home, dbFile };
}

function autoRunner(state: AutoState, text = LOGGED_IN): Runner {
  return async (args) => {
    state.calls.push(args);
    if (args[0] === "browsers" && args[1] === "--json") return { stdout: JSON.stringify(state.online), exitCode: 0 };
    if (args[0] === "browsers" && args[1] === "close") {
      state.closed += 1;
      state.online = [];
      return { stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: false }), exitCode: 0 };
    }
    if (args[0] === "session" && args[1] === "start") return { stdout: JSON.stringify({ session_id: "abcd" }), exitCode: 0 };
    if (args[0] === "session" && args[1] === "stop") return { stdout: "", exitCode: 0 };
    if (args[0] === "navigate") return { stdout: "", exitCode: 0 };
    if (args[0] === "evaluate") return { stdout: JSON.stringify({ ok: true, tab_id: 7, value: text }), exitCode: 0 };
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

function launchDeps(state: AutoState, browser: Browser = edge, overrides: Partial<LaunchDependencies> = {}): LaunchDependencies {
  return {
    platform: "win32",
    freeMemory: () => 2 * 1024 ** 3,
    sleep: async () => {},
    launch: async () => { state.launched += 1; state.online = [browser]; },
    ...overrides,
  };
}

test("离线时自动拉起 Edge 并采到快照，采完只关自己拉起的实例", async (t) => {
  const { home, dbFile } = await launchFixture(t);
  const state: AutoState = { online: [], launched: 0, closed: 0, calls: [] };
  const result = await snapshotOne(home, autoRunner(state), account.alias, 45_000, { dbFile, ...fast, launchDependencies: launchDeps(state) });
  assert.equal(result.ok, true);
  assert.equal(result.connection, "online");
  assert.equal(result.balance, 1100);
  assert.equal(result.launched, true);
  assert.equal(result.closed, true);
  assert.equal(state.launched, 1, "只拉起一次");
  assert.equal(state.closed, 1, "采完立刻关掉，压住内存峰值");
  assert.deepEqual((await readLeftovers(home)).instances, [], "确认关闭后不留遗留追踪");
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].ok, true);
});

test("用户自己开着的 Edge 不会被自动关闭", async (t) => {
  const { home, dbFile } = await launchFixture(t);
  const state: AutoState = { online: [edge], launched: 0, closed: 0, calls: [] };
  const result = await snapshotOne(home, autoRunner(state), account.alias, 45_000, { dbFile, ...fast, launchDependencies: launchDeps(state) });
  assert.equal(result.ok, true);
  assert.equal(result.launched, false);
  assert.equal(result.closed, undefined);
  assert.equal(state.launched, 0);
  assert.equal(state.closed, 0);
  assert.ok(!state.calls.some((args) => args[0] === "browsers" && args[1] === "close"));
});

test("--ensure-online no 保持纯只读：不拉起、不关闭，只报离线", async (t) => {
  const { home, dbFile } = await launchFixture(t);
  const state: AutoState = { online: [], launched: 0, closed: 0, calls: [] };
  const result = await snapshotOne(home, autoRunner(state), account.alias, 45_000, {
    dbFile, ...fast, ensureOnline: false, launchDependencies: launchDeps(state),
  });
  assert.equal(result.errorCode, "OFFLINE");
  assert.equal(state.launched, 0);
  assert.equal(state.closed, 0);
  assert.ok(!state.calls.some((args) => args[0] === "session"));
  assert.match(result.note ?? "", /--ensure-online no/);
});

test("--keep-open 保留自动拉起的窗口，并留下遗留追踪供 close-leftover 兜底", async (t) => {
  const { home, dbFile } = await launchFixture(t);
  const state: AutoState = { online: [], launched: 0, closed: 0, calls: [] };
  const result = await snapshotOne(home, autoRunner(state), account.alias, 45_000, {
    dbFile, ...fast, keepOpen: true, launchDependencies: launchDeps(state),
  });
  assert.equal(result.ok, true);
  assert.equal(result.launched, true);
  assert.equal(state.closed, 0);
  assert.equal(result.closed, undefined);
  assert.equal((await readLeftovers(home)).instances.length, 1);
});

test("自动拉起失败（内存不足）如实留痕，并给出可执行建议", async (t) => {
  const { home, dbFile } = await launchFixture(t);
  const state: AutoState = { online: [], launched: 0, closed: 0, calls: [] };
  const result = await snapshotOne(home, autoRunner(state), account.alias, 45_000, {
    dbFile, ...fast, launchDependencies: launchDeps(state, edge, { freeMemory: () => 100 }),
  });
  assert.equal(result.errorCode, "LOW_MEMORY");
  assert.equal(state.launched, 0, "内存不够时绝不拉起 Edge");
  assert.equal(state.closed, 0);
  assert.match(result.note ?? "", /LOW_MEMORY/);
  assert.match(result.hint ?? "", /close-all/);
  assert.equal(listSnapshots({ alias: account.alias }, dbFile)[0].errorCode, "LOW_MEMORY");
});

test("CLI：--ensure-online no 透传到 snapshot --all", async (t) => {
  const { home, dbFile } = await launchFixture(t);
  const state: AutoState = { online: [], launched: 0, closed: 0, calls: [] };
  const lines: string[] = [];
  const code = await main(["accounts", "snapshot", "--all", "--ensure-online", "no", "--json"], {
    home, run: autoRunner(state), snapshotDbFile: dbFile,
    launchDependencies: launchDeps(state), output: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.equal(state.launched, 0);
  assert.equal(JSON.parse(lines[0]).results[0].errorCode, "OFFLINE");
});

test("CLI：snapshot --missing --capture 只补采今天缺配对快照的账号", async (t) => {
  const second = { ...account, alias: "broken", instanceId: "eeee9999", expectedIdentity: "github_16350" };
  const { home, dbFile } = await launchFixture(t, [account, second]);
  const { insertSnapshot } = await import("../src/db.ts");
  const now = new Date();
  insertSnapshot({
    time: now.toISOString(), alias: account.alias, instanceId: account.instanceId,
    identity: account.expectedIdentity, balance: 1100, totalSpent: 125, ok: true, errorCode: null,
  }, dbFile);
  const state: AutoState = { online: [], launched: 0, closed: 0, calls: [] };
  const lines: string[] = [];
  const code = await main(["accounts", "snapshot", "--missing", "--capture", "--json"], {
    home, run: autoRunner(state), snapshotDbFile: dbFile,
    launchDependencies: launchDeps(state, { ...edge, instance_id: second.instanceId }),
    output: (line) => lines.push(line), now: () => now,
  });
  const report = JSON.parse(lines[0]);
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.missing, [second.alias]);
  assert.deepEqual(report.failed, []);
  assert.equal(report.saved, 1);
  assert.equal(state.launched, 1, "已有配对快照的账号连浏览器都不碰");
  assert.equal(state.closed, 1);
  assert.equal(listSnapshots({ alias: account.alias }, dbFile).length, 1, "不重复采集已有快照的账号");
  assert.equal(listSnapshots({ alias: second.alias }, dbFile)[0].ok, true);
});

test("CLI：--capture 只能搭配 --missing；只读的 --missing 不接受启动参数", async (t) => {
  const { home, dbFile } = await temporary(t);
  const alone: string[] = [];
  assert.equal(await main(["accounts", "snapshot", "--capture", "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => alone.push(line) }), 1);
  assert.match(alone[0], /--capture 只能和 --missing/);
  const readOnly: string[] = [];
  assert.equal(await main(["accounts", "snapshot", "--missing", "--ensure-online", "no", "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => readOnly.push(line) }), 1);
  assert.match(readOnly[0], /只读的 --missing/);
  const bad: string[] = [];
  assert.equal(await main(["accounts", "snapshot", account.alias, "--ensure-online", "maybe", "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => bad.push(line) }), 1);
  assert.match(bad[0], /只接受 yes \/ no/);
  const withSite: string[] = [];
  assert.equal(await main(["accounts", "snapshot", "--missing", "--capture", "--site", "agentrouter", "--json"], { home, run: runner(), snapshotDbFile: dbFile, output: (line) => withSite.push(line) }), 1);
  assert.match(withSite[0], /不接受 --site/);
});
