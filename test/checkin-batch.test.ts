import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_RETRY_CODES, checkinAll, pendingCheckins, readState, writeState } from "../src/checkin-batch.ts";
import { openDatabase } from "../src/db.ts";
import { readLeftovers, recordLaunchedInstance } from "../src/leftover.ts";
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
function clock(start = 0) {
  let now = start;
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
  // 这四个账号本来就在跑（fake runner 直接报在线），本轮没有拉起任何一个，
  // 所以一个都不关——"只关自己拉起的实例"是硬约束，见下一个用例。
  assert.equal(report.released, 0);
  assert.equal(closeCalls.length, 0);
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

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

test("checkin-all: 冷却日志带具体起止时间，长冷却中途报剩余", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const lines: string[] = [];
  await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 12 * 60_000,
    maxRetries: 1,
    onProgress: (line) => lines.push(line),
    ...time,
  });
  const limited = lines.find((line) => line.includes("命中站点登录限流"));
  assert.match(limited ?? "", ISO, "命中限流要带具体时间，不能只说'限流'");
  assert.match(limited ?? "", /CHECKIN_TIMEOUT/, "要说清是哪个错误码触发的");
  const start = lines.find((line) => line.includes("冷却开始"));
  assert.match(start ?? "", ISO, "冷却开始时间");
  assert.match(start ?? "", /12 分钟/);
  const stamps = (start ?? "").match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? [];
  assert.equal(stamps.length, 2, "冷却开始这行要同时给出开始与预计结束时间");
  assert.ok(lines.some((line) => line.includes("冷却结束")), "冷却结束也要记一笔");
  assert.ok(lines.some((line) => line.includes("剩余") && line.includes("分钟")), "长冷却要报剩余时长");
  assert.deepEqual(time.sleeps, [5 * 60_000, 5 * 60_000, 2 * 60_000], "12 分钟按 5 分钟分段等待");
});

test("checkin-all: 短冷却不分段，行为与原来一致", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const lines: string[] = [];
  await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    onProgress: (line) => lines.push(line),
    ...time,
  });
  assert.deepEqual(time.sleeps, [60_000], "不足一整段就是单次等待");
  assert.equal(lines.filter((line) => line.includes("冷却中")).length, 0);
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

/** 往账本里塞一条"今天已到账"的记录，用于预判测试。 */
function seedCredited(file: string, alias: string, instanceId: string, at: Date) {
  const db = openDatabase(file);
  try {
    db.prepare(
      "INSERT INTO checkins (time, alias, instance_id, identity, ok, balance_before, balance_after, credited) VALUES (?, ?, ?, ?, 1, 100, 125, 1)",
    ).run(at.toISOString(), alias, instanceId, "github_1");
  } finally {
    db.close();
  }
}

function tempDb(t: { after: (fn: () => Promise<void>) => void }) {
  const file = join(tmpdir(), `zenx-batch-db-${randomUUID()}.db`);
  t.after(() => rm(file, { force: true }));
  return file;
}

// 签到前的预判：只读账本就知道还差谁，不必为已到账的账号拉起 Edge。
test("pending: 今天已到账的账号不出现在待签名单里", async (t) => {
  const home = await fixture(t);
  const dbFile = tempDb(t);
  seedCredited(dbFile, "alpha", "aaaa1111", new Date("2026-09-21T02:00:00+08:00"));
  const report = await pendingCheckins(home, {
    dbFile,
    now: () => new Date("2026-09-21T10:00:00+08:00"),
  });
  assert.equal(report.date, "2026-09-21");
  assert.deepEqual(report.pending, ["beta"]);
  assert.deepEqual(report.done, ["alpha"]);
});

// 账本读不了时全部算待签：宁可多跑一次，也不能因为读不到记录就漏签。
test("pending: 账本为空时全部账号都是待签", async (t) => {
  const home = await fixture(t);
  const report = await pendingCheckins(home, {
    dbFile: tempDb(t),
    now: () => new Date("2026-09-21T10:00:00+08:00"),
  });
  assert.deepEqual(report.pending, ["alpha", "beta"]);
  assert.deepEqual(report.done, []);
});

test("checkin-all: 今天已到账的账号开跑前就跳过，不进分组也不关实例", async (t) => {
  const home = await fixture(t);
  const dbFile = tempDb(t);
  const day = new Date("2026-09-21T10:00:00+08:00").getTime();
  seedCredited(dbFile, "alpha", "aaaa1111", new Date(day));
  const time = clock(day);
  const closeCalls: string[] = [];
  const spy: Runner = (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") {
      closeCalls.push(args[3]);
      return Promise.resolve({ stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 });
    }
    return runner(args, options);
  };
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    ...time,
    dbFile,
  });
  const byAlias = new Map(report.accounts.map((item) => [item.alias, item]));
  assert.equal(report.skippedAlreadyCredited, 1);
  assert.equal(byAlias.get("alpha")?.skipped, "already_credited_today");
  assert.equal(byAlias.get("alpha")?.attempts, 0, "跳过的账号不该有尝试记录");
  assert.equal(byAlias.get("alpha")?.credited, true, "已到账仍计入到账数，报表才不会少算");
  assert.equal(closeCalls.includes("aaaa1111"), false, "跳过的账号没有实例可关");
});

/**
 * 给账号配一套"存在且可启动"的假 Edge 路径，让 ensure-online 真的走进启动分支
 * （因此 launched = true）。不这么做的话 fake runner 永远报在线，永远走不到
 * "本轮拉起"这条路径，也就测不出关闭的守卫。
 */
async function launchable(home: string, alias: string) {
  const userDataDir = join(home, "User Data");
  const profile = join(userDataDir, `Profile-${alias}`);
  await mkdir(profile, { recursive: true });
  const edgePath = join(home, "msedge.exe");
  await writeFile(edgePath, "fake");
  await writeFile(join(profile, "Preferences"), "{}");
  return { edgePath, userDataDir, profileDirectory: `Profile-${alias}` };
}

// 只关本轮拉起的实例：用户自己开着的 Edge 共用同一个 Profile，
// 关掉它会连标签页和未保存内容一起带走——省内存不值得冒这个险。
test("checkin-all: --close-after 不关闭本来就在跑的 Edge（用户自己的实例）", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const closeCalls: string[] = [];
  const spy: Runner = (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") {
      closeCalls.push(args[3]);
      return Promise.resolve({ stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 });
    }
    return runner(args, options);
  };
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 0,
    closeAfter: true,
    windowSize: 0,
    ...time,
    dbFile: tempDb(t),
  });
  assert.equal(report.accounts.every((item) => item.launched === false), true, "两个账号都本来就在跑");
  assert.equal(report.released, 0);
  assert.deepEqual(closeCalls, [], "一次都不该关：那是用户自己的 Edge");
});

// 守卫靠 launched 判定，所以这个字段必须对：本轮拉起的为 true，本来就在线的为 false。
test("checkin-all: launched 如实记录哪些实例是本轮拉起的", async (t) => {
  const home = await fixture(t);
  const launch = await launchable(home, "alpha");
  await writeFile(
    join(home, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ ...accounts[0], launch }, accounts[1]] }),
  );
  let alphaUp = false;
  const spy: Runner = (args, options) => {
    // alpha 要等"启动"之后才上线；beta 一直在线（= 用户自己开着的）。
    if (args[0] === "browsers") {
      const list = [browser("bbbb2222")];
      if (alphaUp) list.unshift(browser("aaaa1111"));
      return Promise.resolve({ stdout: JSON.stringify(list), exitCode: 0 });
    }
    return runner(args, options);
  };
  const time = clock();
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    // 关掉重试：重试那一轮的 ensure-online 会看到 alpha 已在线（launched=false），
    // 把第一次的真实结果覆盖掉。
    maxRetries: 0,
    windowSize: 0,
    launchDependencies: { launch: async () => { alphaUp = true; }, platform: "win32", sleep: async () => {} },
    ...time,
    dbFile: tempDb(t),
  });
  const byAlias = new Map(report.accounts.map((item) => [item.alias, item]));
  assert.equal(byAlias.get("alpha")?.launched, true, "alpha 的 Edge 是本轮拉起的");
  assert.equal(byAlias.get("beta")?.launched, false, "beta 的 Edge 本来就在跑");
});

test("checkin-all: --force 不做预判，已到账的账号也照样跑", async (t) => {
  const home = await fixture(t);
  const dbFile = tempDb(t);
  const day = new Date("2026-09-21T10:00:00+08:00").getTime();
  seedCredited(dbFile, "alpha", "aaaa1111", new Date(day));
  const time = clock(day);
  const report = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    force: true,
    ...time,
    dbFile,
  });
  assert.equal(report.skippedAlreadyCredited, 0);
  const alpha = report.accounts.find((item) => item.alias === "alpha");
  assert.equal(alpha?.skipped, undefined);
  assert.ok((alpha?.attempts ?? 0) >= 1, "--force 应真的跑一遍");
});

// --- 遗留实例追踪：zenx 拉起的实例落盘，close-leftover 才有据可查 ---

/** alpha 等"启动"后才上线；关闭行为由 closeReply 决定。 */
function launchSpy(alphaUpRef: { up: boolean }, closeReply: (id: string) => Result): Runner {
  return (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") return Promise.resolve(closeReply(args[3]));
    if (args[0] === "browsers") {
      const list = [browser("bbbb2222")];
      if (alphaUpRef.up) list.unshift(browser("aaaa1111"));
      return Promise.resolve({ stdout: JSON.stringify(list), exitCode: 0 });
    }
    return runner(args, options);
  };
}

test("checkin-all: 本轮拉起但关不掉的实例记入 leftover，用户自己的实例不入账", async (t) => {
  const home = await fixture(t);
  const launch = await launchable(home, "alpha");
  await writeFile(
    join(home, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ ...accounts[0], launch }, accounts[1]] }),
  );
  const alphaUp = { up: false };
  const spy = launchSpy(alphaUp, () => ({ stdout: "unknown_method: browser.close", exitCode: 1 }));
  const time = clock();
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 0,
    closeAfter: true,
    launchDependencies: { launch: async () => { alphaUp.up = true; }, platform: "win32", sleep: async () => {} },
    ...time,
    dbFile: tempDb(t),
  });
  assert.match(report.accounts.find((item) => item.alias === "alpha")?.closureError ?? "", /CLOSE_NOT_SUPPORTED/);
  const leftovers = await readLeftovers(home);
  assert.deepEqual(leftovers.instances.map((item) => item.alias), ["alpha"], "只有 zenx 拉起且没关掉的实例才入追踪");
  assert.match(leftovers.instances[0]?.lastCloseError ?? "", /CLOSE_NOT_SUPPORTED/, "失败原因要留下，便于排查");
});

test("checkin-all: 本轮拉起且成功关闭的实例不留 leftover 记录", async (t) => {
  const home = await fixture(t);
  const launch = await launchable(home, "alpha");
  await writeFile(
    join(home, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ ...accounts[0], launch }, accounts[1]] }),
  );
  const alphaUp = { up: false };
  const spy = launchSpy(alphaUp, (id) => ({
    stdout: JSON.stringify({ browser_id: id, closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }),
    exitCode: 0,
  }));
  const time = clock();
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 0,
    closeAfter: true,
    launchDependencies: { launch: async () => { alphaUp.up = true; }, platform: "win32", sleep: async () => {} },
    ...time,
    dbFile: tempDb(t),
  });
  assert.equal(report.released, 1, "alpha 的实例应被释放");
  assert.deepEqual((await readLeftovers(home)).instances, [], "确认关闭后记录应清除");
});

test("checkin-all: --close-leftover 开跑前清理遗留实例，不碰账号自己的实例", async (t) => {
  const home = await fixture(t);
  await recordLaunchedInstance(home, "ghost", "zzzz9999");
  await recordLaunchedInstance(home, "gone", "yyyy9999");
  const closed: string[] = [];
  const spy: Runner = (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") {
      closed.push(args[3]);
      return Promise.resolve({
        stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }),
        exitCode: 0,
      });
    }
    if (args[0] === "browsers") {
      // zzzz9999 在线（无主遗留，应被关闭）；yyyy9999 不在线（记录应被移除）。
      return Promise.resolve({ stdout: JSON.stringify([browser("aaaa1111"), browser("bbbb2222"), browser("zzzz9999")]), exitCode: 0 });
    }
    return runner(args, options);
  };
  const time = clock();
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 0,
    closeLeftover: true,
    windowSize: 0,
    ...time,
    dbFile: tempDb(t),
  });
  assert.deepEqual(closed, ["zzzz9999"], "只清追踪里的遗留实例，账号自己的实例一下都不碰");
  assert.deepEqual(report.leftoverCleanup, { tracked: 2, closed: 1, dropped: 1, failed: 0 });
  assert.deepEqual((await readLeftovers(home)).instances, [], "两条记录都应有归宿");
});
