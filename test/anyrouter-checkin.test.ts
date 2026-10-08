import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyRouter } from "../src/sites/anyrouter.ts";
import { anyrouterCheckin } from "../src/anyrouter-checkin.ts";
import { insertCheckin, insertSnapshot, listCheckins, listSnapshots } from "../src/db.ts";
import { ZenxError } from "../src/core.ts";
import type { Browser, Runner } from "../src/core.ts";

/** 按错误码断言：ZenxError 的 message 是中文说明，错误码在 code 上。 */
async function rejectsWithCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ZenxError && error.code === code,
  );
}

const edge: Browser = {
  instance_id: "a03f225b", browser_name: "Edge", browser_version: "154.0.0.0",
  extension_version: "0.4.0", label: "Edge#a03f", extension_protocol_version: "1.3", version_skew: false,
};

const account = {
  alias: "edge-6",
  instanceId: edge.instance_id,
  expectedIdentity: "github_206707",
  boundAt: "2026-09-13T16:54:35.648Z",
  anyrouterIdentity: "linuxdo_85789",
};

// 实测页面正文（节选）：AnyRouter 控制台登录态
const CONSOLE_LOGGED_IN = `Any Router
首页
控制台
定价
使用指南
L
linuxdo_85789
控制台
数据看板
API令牌
👋晚上好，linuxdo_85789
账户数据
当前余额
$5121.77
历史消耗
$1236.94`;

const CONSOLE_OTHER_USER = CONSOLE_LOGGED_IN.replace(/linuxdo_85789/g, "linuxdo_99999");

type ScriptOptions = {
  text?: string;
  browsers?: Browser[];
  calls?: string[][];
  navigateExitCode?: number;
  startExitCode?: number;
  stopExitCode?: number;
  evaluateStdout?: string;
};

function runner(options: ScriptOptions = {}): Runner {
  return async (args) => {
    options.calls?.push(args);
    if (args[0] === "browsers") return { stdout: JSON.stringify(options.browsers ?? [edge]), exitCode: 0 };
    if (args[0] === "session" && args[1] === "start") {
      return { stdout: JSON.stringify({ session_id: "abcd" }), exitCode: options.startExitCode ?? 0 };
    }
    if (args[0] === "session" && args[1] === "stop") return { stdout: "", exitCode: options.stopExitCode ?? 0 };
    if (args[0] === "navigate") return { stdout: "reached=load", exitCode: options.navigateExitCode ?? 0 };
    if (args[0] === "evaluate") {
      return {
        stdout: options.evaluateStdout ?? JSON.stringify({ ok: true, tab_id: 7, value: options.text ?? CONSOLE_LOGGED_IN }),
        exitCode: 0,
      };
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }, accounts: unknown[] = [account]) {
  const home = await mkdtemp(join(tmpdir(), "zenx-anyrouter-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts }));
  return { home, dbFile: join(home, "checkin.db") };
}

/** 跳过真实等待：PAGE_SETTLE_MS 是 3 秒，测试里不能真等。 */
const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// 站点适配器
// ---------------------------------------------------------------------------

test("balance 读取当前余额", () => {
  assert.equal(anyRouter.parse.balance(CONSOLE_LOGGED_IN), 5121.77);
  assert.equal(anyRouter.parse.balance("没有余额信息"), null);
});

test("totalSpent 读取历史消耗", () => {
  assert.equal(anyRouter.parse.totalSpent(CONSOLE_LOGGED_IN), 1236.94);
  assert.equal(anyRouter.parse.totalSpent("没有消耗信息"), null);
});

test("identity 从问候语提取站点身份", () => {
  assert.equal(anyRouter.classify.identity(CONSOLE_LOGGED_IN), "linuxdo_85789");
  assert.equal(anyRouter.classify.identity("早上好，linuxdo_111 控制台"), "linuxdo_111");
  assert.equal(anyRouter.classify.identity("没有问候语"), null);
});

test("loggedIn 认控制台与问候语", () => {
  assert.equal(anyRouter.classify.loggedIn(CONSOLE_LOGGED_IN), true);
  assert.equal(anyRouter.classify.loggedIn("Any Router Console Dashboard"), true);
  assert.equal(anyRouter.classify.loggedIn("登录 注册"), false);
});

test("适配器元数据", () => {
  assert.equal(anyRouter.domain, "anyrouter.top");
  assert.equal(anyRouter.consoleUrl, "https://anyrouter.top/console");
});

// ---------------------------------------------------------------------------
// 签到流程
// ---------------------------------------------------------------------------

test("签到成功：导航+核对身份+读到余额", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  const result = await anyrouterCheckin(home, runner({ calls }), "edge-6", 60_000, {
    sleep: noSleep, dbFile,
  });
  assert.equal(result.ok, true);
  assert.equal(result.alias, "edge-6");
  assert.equal(result.identity, "linuxdo_85789");
  assert.equal(result.balanceAfter, 5121.77);
  // 首次签到没有基线，无法确认到账，但不算失败
  assert.equal(result.checkinCredited, false);
  assert.equal(result.balanceBefore, null);

  // 导航目标必须是 AnyRouter 控制台
  const navigate = calls.find((c) => c[0] === "navigate");
  assert.ok(navigate?.includes("https://anyrouter.top/console"));
  // 隔离窗口必定回收
  assert.ok(calls.some((c) => c[0] === "session" && c[1] === "stop"));
});

test("账本记在 <别名>@anyrouter 下，与 AgentRouter 分开", async (t) => {
  const { home, dbFile } = await temporary(t);
  await anyrouterCheckin(home, runner(), "edge-6", 60_000, { sleep: noSleep, dbFile });
  const rows = listCheckins({ alias: "edge-6@anyrouter" }, dbFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].identity, "linuxdo_85789");
  assert.equal(rows[0].balanceAfter, 5121.77);
  // AgentRouter 的记录不受影响
  assert.equal(listCheckins({ alias: "edge-6" }, dbFile).length, 0);
});

test("身份不符立即停止，不写成功记录", async (t) => {
  const { home, dbFile } = await temporary(t);
  await rejectsWithCode(
    anyrouterCheckin(home, runner({ text: CONSOLE_OTHER_USER }), "edge-6", 60_000, { sleep: noSleep, dbFile }),
    "IDENTITY_MISMATCH",
  );
  // 失败也要留痕
  const rows = listCheckins({ alias: "edge-6@anyrouter" }, dbFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].errorCode, "IDENTITY_MISMATCH");
});

test("未绑定 AnyRouter 身份时报错", async (t) => {
  const noIdentity = { ...account };
  delete (noIdentity as { anyrouterIdentity?: string }).anyrouterIdentity;
  const { home, dbFile } = await temporary(t, [noIdentity]);
  await rejectsWithCode(
    anyrouterCheckin(home, runner(), "edge-6", 60_000, { sleep: noSleep, dbFile }),
    "ANYROUTER_NOT_BOUND",
  );
});

test("离线时直接返回，不启动 session", async (t) => {
  const { home, dbFile } = await temporary(t);
  const calls: string[][] = [];
  const result = await anyrouterCheckin(home, runner({ browsers: [], calls }), "edge-6", 60_000, {
    sleep: noSleep, dbFile,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "OFFLINE");
  assert.ok(!calls.some((c) => c[0] === "session"));
});

test("当天已到账则跳过，不重复签到", async (t) => {
  const { home, dbFile } = await temporary(t);
  const { start } = (() => {
    const now = new Date();
    return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() };
  })();
  insertCheckin({
    time: new Date(Date.parse(start) + 60_000).toISOString(),
    alias: "edge-6@anyrouter",
    instanceId: edge.instance_id,
    identity: "linuxdo_85789",
    ok: true, balanceBefore: 5096.77, balanceAfter: 5121.77, credited: true, errorCode: null,
  }, dbFile);
  const calls: string[][] = [];
  const result = await anyrouterCheckin(home, runner({ calls }), "edge-6", 60_000, { sleep: noSleep, dbFile });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, "already_credited_today");
  assert.ok(!calls.some((c) => c[0] === "session"));
});

test("有基线且余额增长达到额度时确认到账", async (t) => {
  const { home, dbFile } = await temporary(t);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString();
  insertCheckin({
    time: yesterday,
    alias: "edge-6@anyrouter",
    instanceId: edge.instance_id,
    identity: "linuxdo_85789",
    ok: true, balanceBefore: null, balanceAfter: 5096.77, credited: false, errorCode: null,
  }, dbFile);
  const result = await anyrouterCheckin(home, runner(), "edge-6", 60_000, { sleep: noSleep, dbFile });
  assert.equal(result.balanceBefore, 5096.77);
  assert.equal(result.balanceAfter, 5121.77);
  assert.equal(result.checkinCredited, true);
});

for (const scenario of [
  { name: "净余额下降但加回消耗到账25", spent: 1366.55, credit: 25, credited: true },
  { name: "只有消耗没有发放", spent: 1341.55, credit: 0, credited: false },
  { name: "累计消耗回退不产生假到账", spent: 1200, credit: -72.25, credited: false },
]) {
  test(`AnyRouter 配对基线：${scenario.name}`, async (t) => {
    const { home, dbFile } = await temporary(t);
    const now = new Date();
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString();
    insertSnapshot({ time, alias: "edge-6@anyrouter", instanceId: edge.instance_id,
      identity: account.anyrouterIdentity, balance: 5114.41, totalSpent: 1269.3, ok: true, errorCode: null }, dbFile);
    const text = CONSOLE_LOGGED_IN.replace("5121.77", "5042.16").replace("1236.94", String(scenario.spent));
    const result = await anyrouterCheckin(home, runner({ text }), "edge-6", 60_000, { sleep: noSleep, dbFile });
    assert.equal(result.balanceBefore, 5114.41);
    assert.equal(result.balanceAfter, 5042.16);
    assert.equal(result.creditDelta, scenario.credit);
    assert.equal(result.checkinCredited, scenario.credited);
    const checkin = listCheckins({ alias: "edge-6@anyrouter" }, dbFile)[0];
    const snapshot = listSnapshots({ alias: "edge-6@anyrouter" }, dbFile)[0];
    assert.equal(checkin.time, snapshot.time, "同次观测的签到和快照必须共用时间戳，供次日配对");
  });
}

for (const kind of ["stale", "newer-checkin", "missing-spent"] as const) {
  test(`AnyRouter 不用不可靠消耗基线制造到账：${kind}`, async (t) => {
    const { home, dbFile } = await temporary(t);
    const now = new Date();
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (kind === "stale" ? 4 : 1), 12).toISOString();
    insertSnapshot({ time, alias: "edge-6@anyrouter", instanceId: edge.instance_id,
      identity: account.anyrouterIdentity, balance: 5114.41, totalSpent: 1269.3, ok: true, errorCode: null }, dbFile);
    if (kind === "newer-checkin") insertCheckin({ time: new Date(Date.parse(time) + 1000).toISOString(),
      alias: "edge-6@anyrouter", instanceId: edge.instance_id, identity: account.anyrouterIdentity,
      ok: true, balanceBefore: null, balanceAfter: 5114.41, credited: false, errorCode: null }, dbFile);
    const text = CONSOLE_LOGGED_IN.replace("5121.77", "5042.16").replace("1236.94", "1366.55");
    const result = await anyrouterCheckin(home, runner({ text: kind === "missing-spent" ? text.split("历史消耗")[0] : text }),
      "edge-6", 60_000, { sleep: noSleep, dbFile });
    assert.equal(result.spentDelta, null);
    assert.equal(result.creditDelta, -72.25);
    assert.equal(result.checkinCredited, false);
  });
}

test("AnyRouter 首次建立基线后次日消费抵扣仍能确认到账", async (t) => {
  const { home, dbFile } = await temporary(t);
  const at = new Date(2026, 9, 4, 12);
  const firstText = CONSOLE_LOGGED_IN.replace("5121.77", "5114.41").replace("1236.94", "1269.30");
  const first = await anyrouterCheckin(home, runner({ text: firstText }), "edge-6", 60_000,
    { dbFile, sleep: noSleep, wallNow: () => at });
  assert.equal(first.checkinCredited, false);
  assert.equal(first.balanceBefore, null);
  at.setDate(at.getDate() + 1);
  const secondText = CONSOLE_LOGGED_IN.replace("5121.77", "5042.16").replace("1236.94", "1366.55");
  const second = await anyrouterCheckin(home, runner({ text: secondText }), "edge-6", 60_000,
    { dbFile, sleep: noSleep, wallNow: () => at });
  assert.equal(second.spentDelta, 97.25);
  assert.equal(second.creditDelta, 25);
  assert.equal(second.checkinCredited, true);
  const calls: string[][] = [];
  const repeated = await anyrouterCheckin(home, runner({ calls }), "edge-6", 60_000,
    { dbFile, sleep: noSleep, wallNow: () => at });
  assert.equal(repeated.skipped, "already_credited_today");
  assert.ok(!calls.some((args) => args[0] === "session"));
});

test("AnyRouter 跨午夜按观测日核对，不把本次读数当成历史基线", async (t) => {
  const { home, dbFile } = await temporary(t);
  const at = new Date(2026, 9, 5, 23, 59, 59);
  insertSnapshot({ time: new Date(2026, 9, 5, 12).toISOString(), alias: "edge-6@anyrouter",
    instanceId: edge.instance_id, identity: account.anyrouterIdentity,
    balance: 5114.41, totalSpent: 1269.3, ok: true, errorCode: null }, dbFile);
  const text = CONSOLE_LOGGED_IN.replace("5121.77", "5042.16").replace("1236.94", "1366.55");
  const result = await anyrouterCheckin(home, runner({ text }), "edge-6", 60_000, {
    dbFile, wallNow: () => at, sleep: async () => { at.setTime(at.getTime() + 3000); },
  });
  assert.equal(result.balanceBefore, 5114.41);
  assert.equal(result.creditDelta, 25);
  assert.equal(result.checkinCredited, true);
  assert.equal(listCheckins({ alias: "edge-6@anyrouter" }, dbFile)[0].time, at.toISOString());
});

test("--force 强制执行，即使当天已到账", async (t) => {
  const { home, dbFile } = await temporary(t);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  insertCheckin({
    time: new Date(Date.parse(todayStart) + 60_000).toISOString(),
    alias: "edge-6@anyrouter",
    instanceId: edge.instance_id,
    identity: "linuxdo_85789",
    ok: true, balanceBefore: 5096.77, balanceAfter: 5121.77, credited: true, errorCode: null,
  }, dbFile);
  const calls: string[][] = [];
  const result = await anyrouterCheckin(home, runner({ calls }), "edge-6", 60_000, {
    sleep: noSleep, dbFile, force: true,
  });
  assert.equal(result.skipped, undefined);
  assert.equal(result.ok, true);
  // 确实执行了导航（不再短路跳过）
  assert.ok(calls.some((c) => c[0] === "navigate"));
});

test("导航失败重试三次后报 SITE_TIMEOUT", async (t) => {
  const { home, dbFile } = await temporary(t);
  await rejectsWithCode(
    anyrouterCheckin(home, runner({ navigateExitCode: 1 }), "edge-6", 60_000, { sleep: noSleep, dbFile }),
    "SITE_TIMEOUT",
  );
});

test("session stop 失败时报告 CLEANUP_INCOMPLETE，但签到结果不变", async (t) => {
  const { home, dbFile } = await temporary(t);
  const reported: string[] = [];
  const result = await anyrouterCheckin(home, runner({ stopExitCode: 1 }), "edge-6", 60_000, {
    sleep: noSleep,
    dbFile,
    report: (error) => reported.push(error.code),
  });
  assert.equal(result.ok, true);
  assert.ok(reported.includes("CLEANUP_INCOMPLETE"));
});

test("账号不存在时报 ACCOUNT_NOT_FOUND", async (t) => {
  const { home, dbFile } = await temporary(t);
  await rejectsWithCode(
    anyrouterCheckin(home, runner(), "nope", 60_000, { sleep: noSleep, dbFile }),
    "ACCOUNT_NOT_FOUND",
  );
});

// ---------------------------------------------------------------------------
// 账号存储
// ---------------------------------------------------------------------------

test("anyrouterIdentity 可通过绑定写入并读回", async (t) => {
  const { home } = await temporary(t);
  const { bindAnyRouterIdentity, readStore } = await import("../src/core.ts");
  await bindAnyRouterIdentity(home, "edge-6", "linuxdo_85219", true);
  const store = await readStore(home);
  assert.equal(store.accounts[0].anyrouterIdentity, "linuxdo_85219");
  // 不能污染 AgentRouter 的身份
  assert.equal(store.accounts[0].expectedIdentity, "github_206707");
});

test("绑定位身份需要 --confirm", async (t) => {
  const { home } = await temporary(t);
  const { bindAnyRouterIdentity } = await import("../src/core.ts");
  await rejectsWithCode(bindAnyRouterIdentity(home, "edge-6", "linuxdo_85219", false), "CONFIRM_REQUIRED");
});

test("绑定身份为空时报错", async (t) => {
  const { home } = await temporary(t);
  const { bindAnyRouterIdentity } = await import("../src/core.ts");
  await rejectsWithCode(bindAnyRouterIdentity(home, "edge-6", "   ", true), "INVALID_IDENTITY");
});

test("readStore 拒绝非法 anyrouterIdentity", async (t) => {
  const { home } = await temporary(t);
  await writeFile(join(home, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [{ ...account, anyrouterIdentity: 12345 }],
  }));
  const { readStore } = await import("../src/core.ts");
  await rejectsWithCode(readStore(home), "INVALID_STORE");
});

test("账号文件仍然能被正常解析（不带 anyrouterIdentity）", async (t) => {
  const { home } = await temporary(t);
  const noIdentity = { alias: "edge-6", instanceId: edge.instance_id, expectedIdentity: "github_206707", boundAt: account.boundAt };
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [noIdentity] }));
  const { readStore } = await import("../src/core.ts");
  const store = await readStore(home);
  assert.equal(store.accounts[0].anyrouterIdentity, undefined);
  // 原文件没被改写
  const raw = await readFile(join(home, "accounts.json"), "utf8");
  assert.ok(!raw.includes("anyrouterIdentity"));
});
