import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { insertCheckin, listCheckins } from "../src/db.ts";
import { recheckAccount } from "../src/recheck.ts";
import type { Browser, Runner } from "../src/core.ts";

const edge: Browser = {
  instance_id: "1234abcd", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "工作账号", extension_protocol_version: "1.1", version_skew: false,
};
const account = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "github_16350", boundAt: "2026-09-13T09:32:45.124Z" };

const LOGGED_IN = "Agent Router 控制台 数据看板 当前余额 $125.00 历史消耗 $10.00 G github_16350 chevron_down";
const LOGGED_OUT = "Agent Router 首页 控制台 登录 注册 Agent Router 登 录 使用 GitHub 继续 使用 LinuxDO 继续";
const GITHUB_AUTH = "Sign in to GitHub Authorize AgentRouter";

type ScriptOptions = {
  text?: string;
  browsers?: Browser[];
  evaluateStdout?: string;
  calls?: string[][];
  startExitCode?: number;
};

function runner(options: ScriptOptions = {}): Runner {
  return async (args) => {
    options.calls?.push(args);
    if (args[0] === "browsers") return { stdout: JSON.stringify(options.browsers ?? [edge]), exitCode: 0 };
    if (args[0] === "session" && args[1] === "start") {
      return { stdout: JSON.stringify({ session_id: "abcd" }), exitCode: options.startExitCode ?? 0 };
    }
    if (args[0] === "session" && args[1] === "stop") return { stdout: "", exitCode: 0 };
    if (args[0] === "navigate") return { stdout: "", exitCode: 0 };
    if (args[0] === "evaluate") {
      return { stdout: options.evaluateStdout ?? JSON.stringify({ ok: true, tab_id: 7, value: options.text ?? "" }), exitCode: 0 };
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-recheck-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [account] }));
  return { home, dbFile: join(home, "checkin.db") };
}

function record(dbFile: string, overrides: Partial<Parameters<typeof insertCheckin>[0]> = {}) {
  insertCheckin({
    time: new Date().toISOString(),
    alias: account.alias,
    instanceId: account.instanceId,
    identity: account.expectedIdentity,
    ok: true,
    balanceBefore: null,
    balanceAfter: null,
    credited: false,
    errorCode: null,
    ...overrides,
  }, dbFile);
}

const fast = { sleep: async () => {} };

test("离线时不启动窗口，只报告连接状态", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  const result = await recheckAccount(home, runner({ browsers: [], calls }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.connection, "offline");
  assert.equal(result.verdict, "unknown");
  assert.equal(result.ok, false);
  assert.ok(!calls.some((args) => args[0] === "session"), "离线不应启动隔离窗口");
});

test("账本今日已有到账记录即判为已到账", async (t) => {
  const { home, dbFile } = await temporary(t);
  record(dbFile, { balanceBefore: 100, balanceAfter: 125, credited: true });
  const result = await recheckAccount(home, runner({ text: LOGGED_IN }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "credited");
  assert.equal(result.creditedToday, true);
  assert.equal(result.balance, 125);
});

test("站点显示今日已签到即判为已到账", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await recheckAccount(home, runner({ text: `${LOGGED_IN} 今日已签到` }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.verdict, "credited");
  assert.equal(result.siteCheckedIn, true);
});

test("余额相对基线增长达到每日额度即判为已到账（补登录发放场景）", async (t) => {
  const { home, dbFile } = await temporary(t);
  record(dbFile, { time: new Date(Date.now() - 86_400_000).toISOString(), balanceAfter: 1000, credited: false });
  const result = await recheckAccount(home, runner({ text: "控制台 当前余额 $1025.00 G github_16350 chevron_down" }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.verdict, "credited");
  assert.equal(result.baselineBalance, 1000);
  assert.equal(result.balanceDelta, 25);
  assert.equal(result.creditedToday, false);
});

// 额度未必由 checkin 发放（login 恢复登录态也会发放）。钱领到了就不该因为记录路径
// 不同而从账本里消失，否则报表会把它当"没签到"——这正是"统计与实际不符"的一大来源。
test("确认到账但账本今天没有记录时补记一条到账记录", async (t) => {
  const { home, dbFile } = await temporary(t);
  record(dbFile, { time: new Date(Date.now() - 86_400_000).toISOString(), balanceAfter: 1000, credited: false });
  const result = await recheckAccount(home, runner({ text: "控制台 当前余额 $1025.00 G github_16350 chevron_down" }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.verdict, "credited");
  assert.equal(result.recorded, true);
  const rows = listCheckins({ alias: account.alias }, dbFile);
  const today = rows.find((row) => row.credited && row.balanceAfter === 1025);
  assert.ok(today, "今天应出现一条 credited 记录");
  assert.equal(today?.balanceBefore, 1000);
  assert.equal(today?.ok, true);
});

test("--record no 时不写账本", async (t) => {
  const { home, dbFile } = await temporary(t);
  record(dbFile, { time: new Date(Date.now() - 86_400_000).toISOString(), balanceAfter: 1000, credited: false });
  const result = await recheckAccount(home, runner({ text: "控制台 当前余额 $1025.00 G github_16350 chevron_down" }), account.alias, 45_000, { dbFile, record: false, ...fast });
  assert.equal(result.verdict, "credited");
  assert.equal(result.recorded, false);
  assert.equal(listCheckins({ alias: account.alias }, dbFile).length, 1, "只留原来那条");
});

test("账本今天已有到账记录时不重复补记", async (t) => {
  const { home, dbFile } = await temporary(t);
  record(dbFile, { balanceBefore: 100, balanceAfter: 125, credited: true });
  const result = await recheckAccount(home, runner({ text: LOGGED_IN }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.verdict, "credited");
  assert.equal(result.recorded, false);
  assert.equal(listCheckins({ alias: account.alias }, dbFile).length, 1);
});

test("已登录但无任何到账证据时判为未到账", async (t) => {
  const { home, dbFile } = await temporary(t);
  record(dbFile, { time: new Date(Date.now() - 86_400_000).toISOString(), balanceAfter: 1100, credited: false });
  const result = await recheckAccount(home, runner({ text: "控制台 当前余额 $1100.00 G github_16350 chevron_down" }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "not_credited");
  assert.equal(result.balanceDelta, 0);
});

test("缺少发放前余额基准时判为未到账，并在说明里讲清无法比较增量", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await recheckAccount(home, runner({ text: LOGGED_IN }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.verdict, "not_credited");
  assert.equal(result.baselineBalance, null);
  assert.match(result.note ?? "", /缺少发放前余额基准/);
});

test("当前未登录时判为需人工登录，不给出额度结论", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await recheckAccount(home, runner({ text: LOGGED_OUT }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.login, "logged_out");
  assert.equal(result.verdict, "logged_out");
  assert.equal(result.balance, null);
});

test("遇到 GitHub 授权页时停止判断并回传页面特征", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await recheckAccount(home, runner({ text: GITHUB_AUTH }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.verdict, "manual_intervention");
  assert.equal(result.pageFeature, "Sign in to GitHub");
});

test("登录身份与绑定不符时判为身份不符", async (t) => {
  const { home, dbFile } = await temporary(t);
  const result = await recheckAccount(home, runner({ text: "控制台 当前余额 $100.00 G github_99999 chevron_down 今日已签到" }), account.alias, 45_000, { dbFile, ...fast });
  assert.equal(result.verdict, "identity_mismatch");
  assert.equal(result.ok, false);
  assert.equal(result.identityMatch, false);
});

test("隔离窗口必定回收", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  await recheckAccount(home, runner({ text: LOGGED_IN, calls }), account.alias, 45_000, { dbFile, ...fast });
  assert.ok(calls.some((args) => args[0] === "session" && args[1] === "stop" && args[2] === "abcd"));
});

test("页面求值异常时报 RECHECK_EVAL_FAILED 且仍回收窗口", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  await assert.rejects(
    recheckAccount(home, runner({ evaluateStdout: "not-json", calls }), account.alias, 45_000, { dbFile, ...fast }),
    { code: "RECHECK_EVAL_FAILED" },
  );
  assert.ok(calls.some((args) => args[0] === "session" && args[1] === "stop"));
});

test("CLI：已到账退出码 0，未到账退出码 1", async (t) => {
  const { home, dbFile } = await temporary(t);
  record(dbFile, { balanceBefore: 100, balanceAfter: 125, credited: true });
  const lines: string[] = [];
  assert.equal(await main(["accounts", "recheck", account.alias, "--json"], { home, run: runner({ text: LOGGED_IN }), recheckDbFile: dbFile, output: (line) => lines.push(line) }), 0);
  assert.equal(JSON.parse(lines[0]).verdict, "credited");

  const other: string[] = [];
  const empty = join(home, "empty.db");
  assert.equal(await main(["accounts", "recheck", account.alias, "--json"], { home, run: runner({ text: LOGGED_IN }), recheckDbFile: empty, output: (line) => other.push(line) }), 1);
  assert.equal(JSON.parse(other[0]).verdict, "not_credited");
});

test("CLI：recheck 不接受签到专用参数", async (t) => {
  const { home, dbFile } = await temporary(t);
  const lines: string[] = [];
  assert.equal(await main(["accounts", "recheck", account.alias, "--force", "--json"], { home, run: runner(), recheckDbFile: dbFile, output: (line) => lines.push(line) }), 1);
  assert.match(lines[0], /INVALID_ARGUMENT/);
});

test("CLI：缺少别名时报错", async (t) => {
  const { home, dbFile } = await temporary(t);
  const lines: string[] = [];
  assert.equal(await main(["accounts", "recheck", "--json"], { home, run: runner(), recheckDbFile: dbFile, output: (line) => lines.push(line) }), 1);
  assert.match(lines[0], /INVALID_ARGUMENT/);
});
