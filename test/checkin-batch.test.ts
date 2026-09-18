import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_RETRY_CODES, checkinAll, readState, writeState } from "../src/checkin-batch.ts";
import type { Account, Browser, Result, Runner } from "../src/core.ts";
import { ZenxError } from "../src/core.ts";

const browser = (instanceId: string): Browser => ({
  instance_id: instanceId,
  browser_name: "Edge",
  browser_version: "140.0",
  extension_version: "0.2.3",
  label: `Edge#${instanceId.slice(0, 4)}`,
  extension_protocol_version: "1.3",
  version_skew: false,
});
const accounts: Account[] = [
  { alias: "alpha", instanceId: "aaaa1111", expectedIdentity: "github_1", boundAt: "2026-09-13T00:00:00Z" },
  { alias: "beta", instanceId: "bbbb2222", expectedIdentity: "github_2", boundAt: "2026-09-13T00:00:00Z" },
];

async function fixture(t: { after: (fn: () => Promise<void>) => void }, store: Account[] = accounts) {
  const home = await mkdtemp(join(tmpdir(), "zenx-batch-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: store }));
  return home;
}

/**
 * 预算极小的假时钟：每次读表前进 100ms，于是 600ms 预算内 checkin 必然抛
 * CHECKIN_TIMEOUT——用它稳定地模拟"任何需要冷却重试的失败"，不必搭完整页面流程。
 */
function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => (now += 100),
    sleep: async (ms: number) => { sleeps.push(ms); },
    sleeps,
    dbFile: join(tmpdir(), `zenx-batch-db-${randomUUID()}.db`),
  };
}

/** 只回答批量流程会问到的两个问题：实例在线、session 能起。 */
const runner: Runner = (args) => {
  const result = (value: unknown): Result => ({ stdout: JSON.stringify(value), exitCode: 0 });
  if (args[0] === "browsers") return Promise.resolve(result(accounts.map((item) => browser(item.instanceId))));
  if (args[0] === "session") return Promise.resolve(result({ session_id: "abcd" }));
  return Promise.resolve(result({ ok: true, value: { finished: 0, events: 0 } }));
};

test("checkin-all: 命中限流后冷却并重跑一轮", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const report = await checkinAll(home, runner, {
    // CHECKIN_TIMEOUT 在真实场景里是 LOGIN_RATE_LIMITED 的同义失败：预算被限流耗光。
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    ...time,
  });
  assert.equal(report.total, 2);
  assert.equal(report.rounds, 2, "限流后应进入第二轮");
  assert.equal(report.waitedMs, 60_000, "应完整冷却一次");
  assert.deepEqual(time.sleeps, [60_000]);
  const byAlias = new Map(report.accounts.map((item) => [item.alias, item]));
  assert.equal(byAlias.get("alpha")?.code, "CHECKIN_TIMEOUT");
  assert.ok((byAlias.get("alpha")?.attempts ?? 0) >= 1);
  assert.ok((byAlias.get("alpha")?.attempts ?? 0) <= 2, "每个账号最多重试一次");
  assert.ok((byAlias.get("beta")?.attempts ?? 0) <= 2);

  const state = await readState(join(home, "checkin-state.json"));
  assert.equal(state.accounts.alpha.lastCode, "CHECKIN_TIMEOUT");
  assert.ok(state.accounts.alpha.attempts >= 1);
});

test("checkin-all: retries=0 时不冷却、不重跑", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const report = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 0,
    ...time,
  });
  assert.equal(report.rounds, 1);
  assert.equal(report.waitedMs, 0);
  assert.deepEqual(time.sleeps, []);
});

test("checkin-all: 非限流错误码不进冷却队列", async (t) => {
  const home = await fixture(t, [{ alias: "solo", instanceId: "cccc3333", expectedIdentity: "github_3", boundAt: "2026-09-13T00:00:00Z" }]);
  const time = clock();
  const report = await checkinAll(home, runner, {
    // 只把 RATE_LIMIT 视为限流：CHECKIN_TIMEOUT 这次应当直接判失败。
    retryCodes: ["LOGIN_RATE_LIMITED"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    ...time,
  });
  assert.equal(report.rounds, 1);
  assert.equal(report.waitedMs, 0);
  assert.equal(report.accounts[0].rateLimited, false);
  assert.equal(report.failed, 1);
});

test("checkin-all: 未知别名直接报错，不静默跳过", async (t) => {
  const home = await fixture(t);
  const time = clock();
  await assert.rejects(
    checkinAll(home, runner, { aliases: ["ghost"], ...time }),
    (error: unknown) => error instanceof ZenxError && error.code === "ACCOUNT_NOT_FOUND",
  );
});

test("checkin-all: 默认把 LOGIN_RATE_LIMITED 与 LOGIN_TIMEOUT 视为限流", () => {
  assert.deepEqual(DEFAULT_RETRY_CODES, ["LOGIN_RATE_LIMITED", "LOGIN_TIMEOUT"]);
});

// 内存峰值 = 窗口大小，而不是账号总数：一组签完就关掉它们的 Edge 实例再拉下一组。
test("checkin-all: --window 把账号分组，每组结束就释放实例", async (t) => {
  const four: Account[] = [
    { alias: "a1", instanceId: "i1", expectedIdentity: "g1", boundAt: "2026-09-13T00:00:00Z" },
    { alias: "a2", instanceId: "i2", expectedIdentity: "g2", boundAt: "2026-09-13T00:00:00Z" },
    { alias: "a3", instanceId: "i3", expectedIdentity: "g3", boundAt: "2026-09-13T00:00:00Z" },
    { alias: "a4", instanceId: "i4", expectedIdentity: "g4", boundAt: "2026-09-13T00:00:00Z" },
  ];
  const home = await fixture(t, four);
  const time = clock();
  const closeCalls: string[] = [];
  const spy: Runner = (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") {
      closeCalls.push(args[3]);
      return Promise.resolve({ stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 });
    }
    if (args[0] === "browsers") return Promise.resolve({ stdout: JSON.stringify(four.map((item) => browser(item.instanceId))), exitCode: 0 });
    return runner(args, options);
  };
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    windowSize: 2,
    ...time,
  });
  assert.equal(report.groups, 2, "4 个账号按 2 分组应分成 2 组");
  assert.equal(report.windowSize, 2);
  assert.equal(report.released, 4, "每组结束都应关闭其中账号的实例");
  assert.equal(closeCalls.length, 4);
  assert.deepEqual(closeCalls.sort(), ["i1", "i2", "i3", "i4"]);
});

test("checkin-all: --window 0 不分组、不自动关闭实例", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const closeCalls: string[] = [];
  const spy: Runner = (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") { closeCalls.push(args[3]); }
    return runner(args, options);
  };
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    windowSize: 0,
    ...time,
  });
  assert.equal(report.groups, 1);
  assert.equal(report.windowSize, 0);
  assert.equal(report.released, 0);
  assert.equal(closeCalls.length, 0);
});

test("状态文件：可回读，损坏时退化为空状态而不抛错", async (t) => {
  const home = await fixture(t);
  const file = join(home, "checkin-state.json");
  await writeState(file, {
    version: 1,
    updatedAt: "2026-09-18T00:00:00.000Z",
    accounts: {
      alpha: { lastAttempt: "2026-09-18T00:00:00.000Z", lastResult: "rate_limited", lastCode: "LOGIN_RATE_LIMITED", attempts: 1, balanceAfter: null, credited: false },
    },
  });
  const state = await readState(file);
  assert.equal(state.accounts.alpha.lastResult, "rate_limited");
  assert.equal(state.accounts.alpha.lastCode, "LOGIN_RATE_LIMITED");

  await writeFile(file, "{ 不是 JSON");
  assert.deepEqual((await readState(file)).accounts, {});
  // 写坏之后仍能正常落盘，不影响后续追踪。
  await writeState(file, { version: 1, updatedAt: "", accounts: { beta: { lastAttempt: "x", lastResult: "credited", lastCode: null, attempts: 1, balanceAfter: 100, credited: true } } });
  assert.equal((await readState(file)).accounts.beta.lastResult, "credited");
  await readFile(file, "utf8");
});
