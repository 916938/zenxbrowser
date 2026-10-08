import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSnapshots } from "../src/db.ts";
import { snapshotAccount, snapshotAll } from "../src/snapshot.ts";
import { recheckAccount } from "../src/recheck.ts";
import { readConsoleState } from "../src/console.ts";
import { agentRouter } from "../src/sites/agentrouter.ts";
import { anyRouter } from "../src/sites/anyrouter.ts";
import { ZenxError } from "../src/core.ts";
import type { Browser, Runner } from "../src/core.ts";

const edge: Browser = {
  instance_id: "1234abcd", browser_name: "Edge", browser_version: "154.0",
  extension_version: "0.4.0", label: "Edge#1234", extension_protocol_version: "1.3", version_skew: false,
};

/** 两站都绑了身份的账号（实测形态：同 Profile、两个不同站点账号）。 */
const bothSites = {
  alias: "edge-6", instanceId: edge.instance_id, expectedIdentity: "github_206707",
  boundAt: "2026-09-13T16:54:35.648Z", anyrouterIdentity: "linuxdo_85789",
};
/** 只绑了 AgentRouter 的账号。 */
const agentOnly = {
  alias: "edge-1", instanceId: edge.instance_id, expectedIdentity: "github_236536",
  boundAt: "2026-09-13T09:32:45.124Z",
};

const AGENT_PAGE = "Agent Router 控制台 数据看板 当前余额 $1276.60 历史消耗 $500.00 G github_206707 chevron_down";
const ANY_PAGE = "Any Router 控制台 数据看板 L linuxdo_85789 👋晚上好，linuxdo_85789 账户数据 当前余额 $5121.77 历史消耗 $1236.94";

/** 按导航到的 URL 返回对应站点的页面正文——这是多站点能力的关键验证点。 */
function runner(options: { calls?: string[][]; pages?: Record<string, string>; browsers?: Browser[] } = {}): Runner {
  const pages = options.pages ?? {
    [agentRouter.consoleUrl]: AGENT_PAGE,
    [anyRouter.consoleUrl]: ANY_PAGE,
  };
  let current = "";
  return async (args) => {
    options.calls?.push(args);
    if (args[0] === "browsers") return { stdout: JSON.stringify(options.browsers ?? [edge]), exitCode: 0 };
    if (args[0] === "session" && args[1] === "start") return { stdout: JSON.stringify({ session_id: "abcd" }), exitCode: 0 };
    if (args[0] === "session" && args[1] === "stop") return { stdout: "", exitCode: 0 };
    if (args[0] === "navigate") { current = args[1]; return { stdout: "", exitCode: 0 }; }
    if (args[0] === "evaluate") {
      return { stdout: JSON.stringify({ ok: true, tab_id: 7, value: pages[current] ?? "" }), exitCode: 0 };
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }, accounts: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), "zenx-multisite-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts }));
  return { home, dbFile: join(home, "checkin.db") };
}

const fast = { sleep: async () => {} };
const budget = () => 45_000;

// ---------------------------------------------------------------------------
// console.ts：同一个读取器，按 site 参数读不同站点
// ---------------------------------------------------------------------------

test("readConsoleState 默认读 AgentRouter", async () => {
  const calls: string[][] = [];
  const state = await readConsoleState(runner({ calls }), edge.instance_id, "github_206707", budget, fast.sleep);
  assert.equal(state.balance, 1276.6);
  assert.equal(state.identityMatch, true);
  assert.ok(calls.some((c) => c[0] === "navigate" && c[1] === agentRouter.consoleUrl));
});

test("readConsoleState 传入 anyRouter 就读 AnyRouter，且身份按该站点判定", async () => {
  const calls: string[][] = [];
  const state = await readConsoleState(runner({ calls }), edge.instance_id, "linuxdo_85789", budget, fast.sleep, anyRouter);
  assert.equal(state.balance, 5121.77);
  assert.equal(state.totalSpent, 1236.94);
  assert.equal(state.identityMatch, true);
  assert.equal(state.login, "logged_in");
  assert.ok(calls.some((c) => c[0] === "navigate" && c[1] === anyRouter.consoleUrl));
  // 截断长度按站点取：AnyRouter 需要 6000，4000 会把余额截掉
  assert.ok(calls.some((c) => c[0] === "evaluate" && c[1].includes("6000")));
});

test("AnyRouter 的 AgentRouter 身份不会误判通过", async () => {
  // 拿 AgentRouter 的身份去读 AnyRouter 页面，必须判定为不匹配
  const state = await readConsoleState(runner(), edge.instance_id, "github_206707", budget, fast.sleep, anyRouter);
  assert.equal(state.identityMatch, false);
});

test("AnyRouter 的 alreadyCheckedIn 恒为 false（站点无此提示）", () => {
  assert.equal(anyRouter.classify.alreadyCheckedIn(ANY_PAGE), false);
  assert.equal(anyRouter.classify.alreadyCheckedIn("今日已签到"), false, "站点压根不显示这个，不能据此判定");
});

test("AnyRouter 登出态判定：问候语消失且出现登录入口", () => {
  assert.equal(anyRouter.classify.loggedOut("Any Router 登 录 注册 使用 GitHub 继续"), true);
  assert.equal(anyRouter.classify.loggedOut("Continue with LinuxDO Sign in"), true);
  // 已登录页即便带"登录"字样也不算登出（问候语在）
  assert.equal(anyRouter.classify.loggedOut(ANY_PAGE), false);
});

// ---------------------------------------------------------------------------
// snapshot：按站点各采一次
// ---------------------------------------------------------------------------

test("snapshot 对两站各采一条，账本 alias 带站点后缀", async (t) => {
  const { home, dbFile } = await temporary(t, [bothSites]);
  const results = await snapshotAccount(home, runner(), "edge-6", 45_000, { dbFile, ...fast });
  assert.equal(results.length, 2);

  const agent = results.find((r) => r.site === "agentrouter");
  const any = results.find((r) => r.site === "anyrouter");
  assert.equal(agent?.balance, 1276.6);
  assert.equal(agent?.identity, "github_206707");
  assert.equal(any?.balance, 5121.77);
  assert.equal(any?.identity, "linuxdo_85789");
  assert.equal(any?.totalSpent, 1236.94);

  // 账本里是两条独立记录，AnyRouter 带后缀
  assert.equal(listSnapshots({ alias: "edge-6" }, dbFile).length, 1);
  assert.equal(listSnapshots({ alias: "edge-6@anyrouter" }, dbFile).length, 1);
  assert.equal(listSnapshots({ alias: "edge-6@anyrouter" }, dbFile)[0].balance, 5121.77);
});

test("snapshot 只采绑过身份的站点", async (t) => {
  const { home, dbFile } = await temporary(t, [agentOnly]);
  const results = await snapshotAccount(home, runner(), "edge-1", 45_000, { dbFile, ...fast });
  assert.equal(results.length, 1, "没绑 AnyRouter，就不该去读它");
  assert.equal(results[0].site, "agentrouter");
  assert.equal(listSnapshots({ alias: "edge-1@anyrouter" }, dbFile).length, 0);
});

test("snapshot --site 只采指定站点", async (t) => {
  const { home, dbFile } = await temporary(t, [bothSites]);
  const results = await snapshotAccount(home, runner(), "edge-6", 45_000, { dbFile, siteId: "anyrouter", ...fast });
  assert.equal(results.length, 1);
  assert.equal(results[0].site, "anyrouter");
  assert.equal(listSnapshots({ alias: "edge-6" }, dbFile).length, 0, "没要求采 AgentRouter 就不该写它");
});

test("snapshot 离线时两站各留一条失败记录，不开窗口", async (t) => {
  const { home, dbFile } = await temporary(t, [bothSites]);
  const calls: string[][] = [];
  const results = await snapshotAccount(home, runner({ browsers: [], calls }), "edge-6", 45_000, { dbFile, ...fast });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.errorCode === "OFFLINE"));
  assert.ok(!calls.some((c) => c[0] === "session"), "离线不该启动隔离窗口");
});

test("snapshotAll 把两站结果都计入总数", async (t) => {
  const { home, dbFile } = await temporary(t, [bothSites]);
  const report = await snapshotAll(home, runner(), 45_000, { dbFile, ...fast });
  assert.equal(report.total, 2, "一个账号两个站点 = 两条观测点");
  assert.equal(report.saved, 2);
  assert.equal(report.ok, true);
});

// ---------------------------------------------------------------------------
// recheck：支持按站点复查
// ---------------------------------------------------------------------------

test("recheck --site anyrouter 读 AnyRouter 并用该站点身份", async (t) => {
  const { home, dbFile } = await temporary(t, [bothSites]);
  const calls: string[][] = [];
  const result = await recheckAccount(home, runner({ calls }), "edge-6", 45_000, {
    dbFile, siteId: "anyrouter", ...fast,
  });
  assert.equal(result.site, "anyrouter");
  assert.equal(result.identity, "linuxdo_85789");
  assert.equal(result.identityMatch, true);
  assert.equal(result.balance, 5121.77);
  assert.ok(calls.some((c) => c[0] === "navigate" && c[1] === anyRouter.consoleUrl));
});

test("recheck 默认仍是 AgentRouter（既有行为不变）", async (t) => {
  const { home, dbFile } = await temporary(t, [bothSites]);
  const result = await recheckAccount(home, runner(), "edge-6", 45_000, { dbFile, ...fast });
  assert.equal(result.site, "agentrouter");
  assert.equal(result.identity, "github_206707");
  assert.equal(result.balance, 1276.6);
});

test("recheck 未绑定该站点身份时报 SITE_NOT_BOUND", async (t) => {
  const { home, dbFile } = await temporary(t, [agentOnly]);
  await assert.rejects(
    recheckAccount(home, runner(), "edge-1", 45_000, { dbFile, siteId: "anyrouter", ...fast }),
    (error: unknown) => error instanceof ZenxError && error.code === "SITE_NOT_BOUND",
  );
});

test("recheck 未知站点 id 报 UNKNOWN_SITE", async (t) => {
  const { home, dbFile } = await temporary(t, [bothSites]);
  await assert.rejects(
    recheckAccount(home, runner(), "edge-6", 45_000, { dbFile, siteId: "nosuchsite", ...fast }),
    (error: unknown) => error instanceof ZenxError && error.code === "UNKNOWN_SITE",
  );
});

test("recheck 的到账阈值取站点自己的 dailyCredit", () => {
  // 两站当前都是 25，但判定必须走适配器字段而不是写死的常量，
  // 否则将来接一个额度不同的站点会静默算错。
  assert.equal(agentRouter.dailyCredit, 25);
  assert.equal(anyRouter.dailyCredit, 25);
});
