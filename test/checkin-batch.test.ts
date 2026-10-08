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
 * sleep 也会推进时钟（真睡过去时间就变了）：冷却时长是按墙钟算的，
 * 不推进就等于假装等待不耗时，"只补足剩余冷却"根本测不出来。
 */
function clock(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => (now += 100),
    // 墙钟与计时器共用同一条时间线，但读它不推进时钟：日界（"今天"是哪天）
    // 必须稳定，否则同一轮里前后两次读到的日期可能不一致。
    wallNow: () => new Date(now),
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
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

// 非限流错误码不进**冷却**队列（不等待、不消耗限流预算），但失败不该就此丢下：
// 收尾还会补签一轮。
test("checkin-all: 非限流错误码不进冷却队列，收尾仍补签一次", async (t) => {
  const home = await fixture(t, [{ alias: "solo", instanceId: "cccc3333", expectedIdentity: "github_3", boundAt: "2026-09-13T00:00:00Z" }]);
  const time = clock();
  const report = await checkinAll(home, runner, {
    // 只把 RATE_LIMIT 视为限流：CHECKIN_TIMEOUT 这次应当直接判失败。
    retryCodes: ["LOGIN_RATE_LIMITED"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    ...time,
  });
  assert.equal(report.waitedMs, 0, "非限流失败不该冷却");
  assert.deepEqual(time.sleeps, [], "一次都不该等");
  assert.equal(report.accounts[0].rateLimited, false);
  assert.equal(report.accounts[0].attempts, 2, "收尾补签再试一次");
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

// 快照覆盖率：到账判定的 Δ消耗基准来自 balance_snapshots 的配对观测点。
// 以前它靠整轮签到之后单独跑一遍 snapshot --all，而那时 --close-after 已经把
// Profile 关了，只能采到 OFFLINE（实测 2026-10-02 / 10-04：18 和 22 条），
// 基准一断就是几周、判定静默退化成裸余额差。现在采集并入签到，收尾只核对覆盖率。
test("checkin-all: 汇总当日快照覆盖率，缺失的账号要点名", async (t) => {
  const home = await fixture(t);
  const dbFile = tempDb(t);
  const day = new Date("2026-09-21T10:00:00+08:00").getTime();
  const time = clock(day);
  const lines: string[] = [];
  const report = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    onProgress: (line) => lines.push(line),
    ...time,
    dbFile,
  });
  // 这两个账号都以 CHECKIN_TIMEOUT 失败（没走到读页面那一步），所以都没有快照。
  assert.equal(report.snapshots.ok, false);
  assert.equal(report.snapshots.total, 2);
  assert.equal(report.snapshots.saved, 0);
  assert.deepEqual(report.snapshots.missing, ["alpha", "beta"]);
  const warn = lines.find((line) => line.includes("当日快照缺"));
  assert.match(warn ?? "", /alpha, beta/, "缺哪些账号要写明");
  assert.match(warn ?? "", /snapshot/, "要给出补采的办法");
});

test("checkin-all: 已有当日配对快照的账号计入覆盖率，不再报缺", async (t) => {
  const home = await fixture(t);
  const dbFile = tempDb(t);
  const day = new Date("2026-09-21T10:00:00+08:00");
  // alpha 当天已到账并落过配对快照（签到时就地采的那种）：两条记录同一时点，
  // 才满足 db.lastPairedSnapshotBefore 要求的"配对快照就是最新余额观测点"。
  seedCredited(dbFile, "alpha", "aaaa1111", day);
  const db = openDatabase(dbFile);
  try {
    db.prepare(
      "INSERT INTO balance_snapshots (time, alias, instance_id, identity, balance, total_spent, ok) VALUES (?, ?, ?, ?, 125, 70, 1)",
    ).run(day.toISOString(), "alpha", "aaaa1111", "github_1");
    db.prepare("UPDATE checkins SET time = ? WHERE alias = 'alpha'").run(day.toISOString());
  } finally {
    db.close();
  }
  const time = clock(day.getTime());
  const report = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    ...time,
    dbFile,
  });
  assert.equal(report.snapshots.total, 2);
  assert.deepEqual(report.snapshots.missing, ["beta"], "alpha 已有配对快照，只剩 beta 缺");
  assert.equal(report.snapshots.saved, 1);
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

// --- 失败账号的补签：冷却顺带重试 + 收尾补一轮 ---

/**
 * 离线且没配启动路径的账号：ensure-online 立刻抛 LAUNCH_NOT_CONFIGURED，
 * 用它稳定造出一种**非限流**的失败，好把补签队列和限流队列区分开。
 */
const offlineAccounts: Account[] = [
  { alias: "off1", instanceId: "eeee1111", expectedIdentity: "g1", boundAt: "2026-09-13T00:00:00Z" },
  { alias: "off2", instanceId: "eeee2222", expectedIdentity: "g2", boundAt: "2026-09-13T00:00:00Z" },
];

// 开头的账号卡在 BSK_TIMEOUT / PROFILE_CONNECT_TIMEOUT 之类，后面一路顺利：
// 以前它们就这么被丢下了，现在收尾补一轮。
test("checkin-all: 整轮没撞限流时，收尾给失败账号补签一轮", async (t) => {
  const home = await fixture(t, offlineAccounts);
  const time = clock();
  const lines: string[] = [];
  const report = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 1,
    windowSize: 0,
    onProgress: (line) => lines.push(line),
    ...time,
    dbFile: tempDb(t),
  });
  assert.equal(report.waitedMs, 0, "没限流就不该冷却");
  assert.equal(report.rounds, 2, "收尾补签算一轮");
  for (const item of report.accounts) {
    assert.equal(item.attempts, 2, `${item.alias} 失败后应再试一次`);
    assert.equal(item.ok, false);
  }
  const sweep = lines.find((line) => line.includes("收尾补签"));
  assert.match(sweep ?? "", /off1, off2/, "补签名单要写明是谁");
});

// 冷却那十几分钟是干等的，之前失败的账号顺手一起重试——不额外花时间，多一次机会。
test("checkin-all: 冷却期间顺带重试之前失败的账号", async (t) => {
  const home = await fixture(t, [
    offlineAccounts[0],
    { alias: "on2", instanceId: "aaaa1111", expectedIdentity: "g2", boundAt: "2026-09-13T00:00:00Z" },
    { alias: "on3", instanceId: "bbbb2222", expectedIdentity: "g3", boundAt: "2026-09-13T00:00:00Z" },
  ]);
  // 第一轮 on2/on3 在线 → 签到超时（视为限流），off1 离线 → 非限流失败。
  // 从第三轮（= 重试轮）起让 session start 直接失败：那样 on2/on3 是**非限流**失败，
  // 不会再触发一次冷却把排在后面的 off1 挤掉，off1 才真的拿到第二次机会。
  let starts = 0;
  const spy: Runner = (args, options) => {
    if (args[0] === "session" && args[1] === "start" && ++starts > 2) {
      return Promise.resolve({ stdout: "session start failed", exitCode: 1 });
    }
    return runner(args, options);
  };
  const time = clock();
  const lines: string[] = [];
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    windowSize: 0,
    onProgress: (line) => lines.push(line),
    ...time,
    dbFile: tempDb(t),
  });
  const byAlias = new Map(report.accounts.map((item) => [item.alias, item]));
  assert.equal(byAlias.get("off1")?.attempts, 2, "之前失败的账号应被顺带重试");
  assert.equal(byAlias.get("on2")?.attempts, 2);
  assert.equal(byAlias.get("on3")?.attempts, 2, "本组剩余账号照旧推迟到冷却后");
  assert.equal(report.waitedMs, 60_000, "只冷却一次");
  assert.match(lines.find((line) => line.includes("顺带重试")) ?? "", /off1/, "要说清顺带重试了谁");
  assert.match(lines.find((line) => line.includes("随后重试")) ?? "", /on2, on3, off1/, "重试名单含补签账号");
});

// 跨组补签：前面组失败的账号在后面组的冷却里被重新拉起，组末回收必须覆盖它们，
// 否则这些实例会漏在本轮之外（内存和 --close-after 一起失守）。
test("checkin-all: 冷却期间跨组补签拉起的实例，组末照样回收", async (t) => {
  const home = await fixture(t);
  const launch = await launchable(home, "off1");
  await writeFile(
    join(home, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ ...offlineAccounts[0], launch }, offlineAccounts[1], { alias: "on3", instanceId: "aaaa1111", expectedIdentity: "g3", boundAt: "2026-09-13T00:00:00Z" }] }),
  );
  const online = new Set(["aaaa1111"]);
  const closeCalls: string[] = [];
  const spy: Runner = (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") {
      closeCalls.push(args[3]);
      // 关掉即下线：off1 第二次被拉起时才真的是"新拉起"的实例。
      online.delete(args[3]);
      return Promise.resolve({ stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 });
    }
    if (args[0] === "browsers") {
      return Promise.resolve({ stdout: JSON.stringify([...online].map((id) => browser(id))), exitCode: 0 });
    }
    // off1 由 zenx 拉起后卡在 session start（非限流失败）；on3 走完整流程撞签到超时（限流）。
    if (args[0] === "session" && args[1] === "start" && args.includes("eeee1111")) {
      return Promise.resolve({ stdout: "session start failed", exitCode: 1 });
    }
    return runner(args, options);
  };
  const time = clock();
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    windowSize: 2,
    launchDependencies: { launch: async () => { online.add("eeee1111"); }, platform: "win32", sleep: async () => {} },
    ...time,
    dbFile: tempDb(t),
  });
  const byAlias = new Map(report.accounts.map((item) => [item.alias, item]));
  assert.equal(byAlias.get("off1")?.attempts, 2, "前面组失败的账号应被跨组补签");
  assert.deepEqual(closeCalls, ["eeee1111", "eeee1111"], "两次拉起都要回收，第二次不能漏");
  assert.equal(report.released, 2);
});

// 冷却时长：默认 15–18 分钟随机（站点约 10–15 分钟恢复），显式 --wait 不抖动。
test("checkin-all: 默认冷却在 15–18 分钟之间取值", async (t) => {
  const home = await fixture(t);
  const short = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 1,
    random: () => 0,
    ...clock(),
    dbFile: tempDb(t),
  });
  assert.equal(short.waitedMs, 15 * 60_000, "随机取下限：15 分钟");
  const long = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 1,
    random: () => 1,
    ...clock(),
    dbFile: tempDb(t),
  });
  assert.equal(long.waitedMs, 18 * 60_000, "随机取上限：18 分钟");
});

// 冷却是墙钟账：共享配额从第一次撞限流起恢复，中途再撞只补差额，不重新计满。
// 站点侧配额不会因为我们换了组、重新登录了几个账号就额外多等一段时间。
test("checkin-all: 再次撞限流只补足剩余冷却，不重新计满", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const lines: string[] = [];
  // 第一次冷却取下限 15 分钟，第二次取上限 18 分钟：第二次只该补 3 分钟出头。
  const picks = [0, 1];
  const report = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    maxRetries: 1,
    windowSize: 1,
    random: () => picks.shift() ?? 1,
    onProgress: (line) => lines.push(line),
    ...time,
    dbFile: tempDb(t),
  });
  assert.equal(time.sleeps.length, 4, "15 分钟按 5 分钟分段3 次，第二次冷却 1 次");
  assert.deepEqual(time.sleeps.slice(0, 3), [5 * 60_000, 5 * 60_000, 5 * 60_000]);
  const second = time.sleeps[3];
  assert.ok(second > 0 && second <= 3 * 60_000, `第二次冷却应只剩 3 分钟以内，实际 ${second}ms`);
  assert.ok(report.waitedMs < 18 * 60_000, `总共不该等满两轮，实际 ${report.waitedMs}ms`);
  assert.match(lines.find((line) => line.includes("距首次限流已过")) ?? "", /已过 1[56](\.\d)? 分钟/, "要说清是补足剩余冷却");
});

test("checkin-all: 已经等够冷却时直接重试，不再多睡一轮", async (t) => {
  const home = await fixture(t);
  const time = clock();
  const lines: string[] = [];
  const report = await checkinAll(home, runner, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    windowSize: 1,
    onProgress: (line) => lines.push(line),
    ...time,
    dbFile: tempDb(t),
  });
  assert.deepEqual(time.sleeps, [60_000], "第二次限流时已经等够 1 分钟，不该再睡一次");
  assert.equal(report.waitedMs, 60_000);
  assert.match(lines.find((line) => line.includes("冷却已等够")) ?? "", /直接重试 1 个账号：beta/, "要说清是直接重试");
});

// 只关自己拉起的实例，但"自己拉起"要跨轮记忆：重试那轮实例已在线，
// ensure-online 不会再报 launched=true（限流后冷却重试成功的账号就是这么漏掉的）。
test("checkin-all: 上一轮拉起、这一轮仍在线的实例照常回收", async (t) => {
  const home = await fixture(t);
  const launch = await launchable(home, "alpha");
  await writeFile(
    join(home, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ ...accounts[0], launch }, accounts[1]] }),
  );
  const alphaUp = { up: false };
  const closeCalls: string[] = [];
  const spy = launchSpy(alphaUp, (id) => {
    closeCalls.push(id);
    return { stdout: JSON.stringify({ browser_id: id, closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 };
  });
  const time = clock();
  const report = await checkinAll(home, spy, {
    retryCodes: ["CHECKIN_TIMEOUT"],
    checkinTimeoutMs: 600,
    waitMs: 60_000,
    maxRetries: 1,
    closeAfter: true,
    windowSize: 0,
    launchDependencies: { launch: async () => { alphaUp.up = true; }, platform: "win32", sleep: async () => {} },
    ...time,
    dbFile: tempDb(t),
  });
  assert.equal(report.rounds, 2, "限流冷却后重试过一轮");
  assert.equal(report.accounts.find((item) => item.alias === "alpha")?.launched, true, "alpha 的 Edge 是本轮拉起的");
  assert.deepEqual(closeCalls, ["aaaa1111"], "alpha 是 zenx 拉起的，重试轮结束照样关掉");
  assert.equal(report.released, 1);
});
