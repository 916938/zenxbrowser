import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { checkAccounts, createRunner, readStore, withStoreLock, ZenxError } from "../src/core.ts";
import type { Account, Browser, Runner } from "../src/core.ts";
import { configureLaunch, ensureOnline } from "../src/launch.ts";
import type { LaunchConfig } from "../src/launch.ts";

const edge: Browser = {
  instance_id: "1234abcd", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "工作账号", extension_protocol_version: "1.1", version_skew: false,
};
const account: Account = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "user-1", boundAt: "2026-09-13T00:00:00.000Z" };
const personal: Account = { ...account, alias: "personal", instanceId: "eeee1111", expectedIdentity: "user-2" };
const online: Runner = async () => ({ stdout: JSON.stringify([edge]), exitCode: 0 });
const offline: Runner = async () => ({ stdout: "[]", exitCode: 0 });

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-launch-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config: LaunchConfig = { edgePath: join(home, "msedge.exe"), userDataDir: join(home, "User Data"), profileDirectory: "Profile 3" };
  await mkdir(join(config.userDataDir, config.profileDirectory), { recursive: true });
  await writeFile(config.edgePath, "模拟可执行文件，不可启动");
  await writeFile(join(config.userDataDir, config.profileDirectory, "Preferences"), "不读取内容");
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [account, personal], future: "保留顶层字段" }));
  return { home, config };
}

function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return { now: () => time, advance: (ms: number) => { time += ms; }, sleep: async (ms: number) => { sleeps.push(ms); time += ms; }, sleeps };
}

const windows = { skip: process.platform !== "win32" };

test("旧版绑定无需启动配置，在线直接返回且不启动", async (t) => {
  const { home } = await fixture(t);
  assert.equal((await readStore(home)).accounts[0].launch, undefined);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  const result = await ensureOnline(home, online, "work", 1000, { launch: async () => { assert.fail("不应启动"); } });
  assert.deepEqual(result, { ok: true, alias: "work", instanceId: edge.instance_id, connection: "online", launched: false, identity: "not_verified" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

test("ensure-online 接受协议 1.3，不启动、不修改绑定", async (t) => {
  const { home } = await fixture(t);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  const run: Runner = async (args) => {
    assert.deepEqual(args, ["browsers", "--json"]);
    return { stdout: JSON.stringify([{ ...edge, extension_protocol_version: "1.3" }]), exitCode: 0 };
  };
  const result = await ensureOnline(home, run, "work", 1000, { now: () => 0, launch: async () => { assert.fail("不应启动"); } });
  assert.deepEqual(result, { ok: true, alias: "work", instanceId: edge.instance_id, connection: "online", launched: false, identity: "not_verified" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

test("保存配置保留绑定、其他账号和未知字段，修改仍需确认", windows, async (t) => {
  const { home, config } = await fixture(t);
  const saved = await configureLaunch(home, "work", config, true);
  assert.deepEqual(saved, { ...account, launch: config });
  const raw = JSON.parse(await readFile(join(home, "accounts.json"), "utf8"));
  assert.equal(raw.future, "保留顶层字段");
  assert.deepEqual(raw.accounts[1], personal);
  raw.accounts[0].futureAccount = 123;
  raw.accounts[0].launch.futureLaunch = 456;
  await writeFile(join(home, "accounts.json"), JSON.stringify(raw));
  await assert.rejects(configureLaunch(home, "work", config, false), { code: "CONFIRM_REQUIRED" });
  await configureLaunch(home, "work", config, true);
  const updated = JSON.parse(await readFile(join(home, "accounts.json"), "utf8"));
  assert.equal(updated.accounts[0].futureAccount, 123);
  assert.equal(updated.accounts[0].launch.futureLaunch, 456);
  assert.deepEqual(updated.accounts[1], personal);
  assert.deepEqual((await readdir(home)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("未确认、未知别名均不保存配置", windows, async (t) => {
  const { home, config } = await fixture(t);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  await assert.rejects(configureLaunch(home, "work", config, false), { code: "CONFIRM_REQUIRED" });
  await assert.rejects(configureLaunch(home, "unknown", config, true), { code: "ACCOUNT_NOT_FOUND" });
  await assert.rejects(ensureOnline(home, async () => { assert.fail("不应查询"); }, "unknown"), { code: "ACCOUNT_NOT_FOUND" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

for (const profileDirectory of [".", "..", "../Default", "a\\b", '"Default"', "a:b", "a\n", "a\x00", "a?", "a*", "a|b", "a<b", "a>b", "Default.", "Default ", "CON", "NUL.txt", ""]) {
  test(`拒绝危险 Profile 子目录 ${JSON.stringify(profileDirectory)}`, async (t) => {
    const { home } = await fixture(t);
    await assert.rejects(configureLaunch(home, "work", { edgePath: "C:\\Edge\\msedge.exe", userDataDir: "C:\\User Data", profileDirectory }, true), { code: "INVALID_LAUNCH_CONFIG" });
  });
}

for (const edgePath of ["msedge.exe", "C:msedge.exe", "\\Edge\\msedge.exe", "\\\\server\\share\\msedge.exe", "C:\\Edge\\chrome.exe", 'C:\\a"b\\msedge.exe', "C:\\Edge:stream\\msedge.exe"]) {
  test(`拒绝非本地绝对 Edge 文件路径 ${JSON.stringify(edgePath)}`, async (t) => {
    const { home } = await fixture(t);
    await assert.rejects(configureLaunch(home, "work", { edgePath, userDataDir: "C:\\Data", profileDirectory: "Default" }, true), { code: "INVALID_LAUNCH_CONFIG" });
  });
}

test("相对数据目录、缺少文件和 Preferences 均失败且不创建 Profile", windows, async (t) => {
  const { home, config } = await fixture(t);
  await assert.rejects(configureLaunch(home, "work", { ...config, userDataDir: "relative" }, true), { code: "INVALID_LAUNCH_CONFIG" });
  for (const invalid of [
    { ...config, edgePath: join(home, "missing", "msedge.exe") },
    { ...config, userDataDir: join(home, "missing") },
    { ...config, profileDirectory: "Profile 999" },
  ]) await assert.rejects(configureLaunch(home, "work", invalid, true), { code: "INVALID_LAUNCH_PATH" });
  await rm(join(config.userDataDir, config.profileDirectory, "Preferences"));
  await assert.rejects(configureLaunch(home, "work", config, true), { code: "INVALID_LAUNCH_PATH" });
  assert.deepEqual(await readdir(config.userDataDir), [config.profileDirectory]);
});

test("畸形启动结构不能读取，物理路径缺失不影响只读检查", async (t) => {
  const { home } = await fixture(t);
  for (const launch of [null, {}, [], "bad", { edgePath: "C:\\msedge.exe", userDataDir: "C:\\Data", profileDirectory: ".." }]) {
    await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [{ ...account, launch }] }));
    await assert.rejects(readStore(home), { code: "INVALID_STORE" });
  }
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [{ ...account, launch: { edgePath: "C:\\missing\\msedge.exe", userDataDir: "C:\\missing\\Data", profileDirectory: "Default" } }] }));
  assert.equal((await checkAccounts(home, online)).ok, true);
  assert.equal((await ensureOnline(home, online, "work")).launched, false);
});

test("不同别名不能复用大小写及斜杠变化后的同一 Profile", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  for (const duplicate of [config, { ...config, userDataDir: config.userDataDir.toUpperCase().replace(/\\/g, "/") + "/", profileDirectory: config.profileDirectory.toLowerCase() }]) {
    await assert.rejects(configureLaunch(home, "personal", duplicate, true), { code: "LAUNCH_PROFILE_IN_USE" });
  }
  await mkdir(join(config.userDataDir, "Default"));
  await writeFile(join(config.userDataDir, "Default", "Preferences"), "模拟");
  await configureLaunch(home, "personal", { ...config, profileDirectory: "Default" }, true);
});

test("junction 逃逸被拒绝，数据目录真实路径别名不能重复", windows, async (t) => {
  const { home, config } = await fixture(t);
  const outside = join(home, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "Preferences"), "模拟");
  await symlink(outside, join(config.userDataDir, "Escape"), "junction");
  await assert.rejects(configureLaunch(home, "work", { ...config, profileDirectory: "Escape" }, true), { code: "INVALID_LAUNCH_PATH" });
  await configureLaunch(home, "work", config, true);
  const linkedRoot = join(home, "linked-data");
  await symlink(config.userDataDir, linkedRoot, "junction");
  await assert.rejects(configureLaunch(home, "personal", { ...config, userDataDir: linkedRoot }, true), { code: "LAUNCH_PROFILE_IN_USE" });
});

test("在线错误浏览器或协议不能成功，不调用启动", async (t) => {
  const { home } = await fixture(t);
  for (const [browser, code] of [[{ ...edge, browser_name: "Chrome" }, "NOT_EDGE"], [{ ...edge, extension_protocol_version: "2.0" }, "UNSUPPORTED_PROTOCOL"]] as const) {
    await assert.rejects(ensureOnline(home, async () => ({ stdout: JSON.stringify([browser]), exitCode: 0 }), "work", 1000, { launch: async () => { assert.fail("不应启动"); } }), { code });
  }
  for (const extension_protocol_version of ["1.2", "1.4", "1.3.0", " 1.3", "1.3 "]) {
    await assert.rejects(ensureOnline(home, async (args) => {
      assert.deepEqual(args, ["browsers", "--json"]);
      return { stdout: JSON.stringify([{ ...edge, extension_protocol_version }]), exitCode: 0 };
    }, "work", 1000, { now: () => 0, launch: async () => { assert.fail("不应启动"); } }), { code: "UNSUPPORTED_PROTOCOL", message: /当前仅支持 1\.0 \/ 1\.1 \/ 1\.3。/ });
  }
  await assert.rejects(ensureOnline(home, offline, "work"), { code: "LAUNCH_NOT_CONFIGURED" });
});

test("离线只启动一次，准确传配置、查询预算和零等待环境", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const time = clock();
  let launched = 0;
  let calls = 0;
  const budgets: number[] = [];
  const run: Runner = async (args, options) => {
    assert.deepEqual(args, ["browsers", "--json"]);
    assert.equal(options?.env?.BSK_BROWSER_WAIT_MS, "0");
    budgets.push(options!.timeoutMs!);
    time.advance(100);
    return { stdout: JSON.stringify(++calls === 3 ? [edge] : []), exitCode: 0 };
  };
  const result = await ensureOnline(home, run, "work", 2000, { ...time, launch: async (value) => { launched++; assert.deepEqual(value, config); } });
  assert.equal(result.launched, true);
  assert.equal(launched, 1);
  assert.deepEqual(budgets, [2000, 1900, 1300]);
  assert.deepEqual(time.sleeps, [500]);
});

test("同名标签或其他实例在线仍超时，保留浏览器且不重复启动", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const time = clock();
  let launches = 0;
  const run: Runner = async () => ({ stdout: JSON.stringify([{ ...edge, instance_id: "eeee1111", label: edge.instance_id }]), exitCode: 0 });
  await assert.rejects(ensureOnline(home, run, "work", 700, { ...time, launch: async () => { launches++; } }), { code: "PROFILE_CONNECT_TIMEOUT" });
  assert.equal(launches, 1);
  assert.deepEqual(time.sleeps, [500, 200]);
  assert.equal(time.now(), 700);
  assert.equal((await readStore(home)).accounts[0].instanceId, edge.instance_id);
});

test("初次查询耗尽预算不启动，迟到的在线响应也不成功", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  for (const browsers of [[], [edge]]) {
    const time = clock();
    await assert.rejects(ensureOnline(home, async () => { time.advance(100); return { stdout: JSON.stringify(browsers), exitCode: 0 }; }, "work", 100, { ...time, launch: async () => { assert.fail("不应启动"); } }), { code: "PROFILE_CONNECT_TIMEOUT" });
  }
});

test("bsk 失败或畸形响应立即停止，查询超时不反复启动", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  for (const [stdout, exitCode, code] of [["[]", 1, "BSK_FAILED"], ["bad", 0, "INVALID_BSK_OUTPUT"], ["{}", 0, "INVALID_BSK_OUTPUT"]] as const) {
    await assert.rejects(ensureOnline(home, async () => ({ stdout, exitCode }), "work", 1000, { launch: async () => { assert.fail("不应启动"); } }), { code });
  }
  let launches = 0;
  let calls = 0;
  await assert.rejects(ensureOnline(home, async () => {
    if (++calls === 1) return { stdout: "[]", exitCode: 0 };
    throw new ZenxError("BSK_TIMEOUT", "模拟查询超时");
  }, "work", 1000, { launch: async () => { launches++; } }), { code: "BSK_TIMEOUT" });
  assert.equal(launches, 1);
  assert.equal(calls, 2);
});

test("启动失败明确报错且释放锁，非 Windows 不启动", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  await assert.rejects(ensureOnline(home, offline, "work", 1000, { launch: async () => { throw new Error("模拟失败"); } }), { code: "EDGE_LAUNCH_FAILED" });
  await assert.rejects(ensureOnline(home, offline, "work", 1000, { platform: "linux", launch: async () => { assert.fail("不应启动"); } }), { code: "UNSUPPORTED_PLATFORM" });
  assert.equal((await ensureOnline(home, online, "work")).launched, false);
});

test("启动中配置与第二次启动互斥，旧锁不自动删除", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let launches = 0;
  let queries = 0;
  const first = ensureOnline(home, async () => ({ stdout: JSON.stringify(++queries === 1 ? [] : [edge]), exitCode: 0 }), "work", 5000, {
    launch: async () => { launches++; entered.resolve(); await release.promise; },
  });
  await entered.promise;
  try {
    await assert.rejects(ensureOnline(home, online, "work"), { code: "STORE_BUSY" });
    await assert.rejects(configureLaunch(home, "work", config, true), { code: "STORE_BUSY" });
  } finally { release.resolve(); }
  assert.equal((await first).launched, true);
  assert.equal(launches, 1);
  await withStoreLock(home, async () => {
    await assert.rejects(ensureOnline(home, online, "work"), { code: "STORE_BUSY" });
  });
  await mkdir(join(home, "accounts.lock"));
  await assert.rejects(configureLaunch(home, "work", config, true), { code: "STORE_BUSY" });
  assert.ok((await readdir(home)).includes("accounts.lock"));
});

test("实际启动函数使用精确无 shell 参数，零退出交接不等于连接成功", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  let spawnCalls = 0;
  let unrefs = 0;
  const child = Object.assign(new EventEmitter(), { unref: () => { unrefs++; } });
  const replacement = ((executable: string, args: string[], options: unknown) => {
    spawnCalls++;
    assert.equal(executable, config.edgePath);
    assert.deepEqual(args, [`--user-data-dir=${config.userDataDir}`, `--profile-directory=${config.profileDirectory}`]);
    assert.deepEqual(options, { shell: false, detached: true, stdio: "ignore" });
    queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0); });
    return child;
  }) as unknown as typeof childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", replacement);
  syncBuiltinESMExports();
  try {
    await assert.rejects(ensureOnline(home, offline, "work", 600, clock()), { code: "PROFILE_CONNECT_TIMEOUT" });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(spawnCalls, 1);
  assert.equal(unrefs, 1);
});

test("实际启动函数接收 spawn 错误而非误报完成", windows, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const replacement = (() => {
    const child = Object.assign(new EventEmitter(), { unref: () => { assert.fail("不应脱离进程"); } });
    queueMicrotask(() => child.emit("error", new Error("模拟系统错误")));
    return child;
  }) as unknown as typeof childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", replacement);
  syncBuiltinESMExports();
  try { await assert.rejects(ensureOnline(home, offline, "work"), { code: "EDGE_LAUNCH_FAILED" }); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("Runner 合并子进程环境且不改变当前环境，超时真正停止子进程", async () => {
  const run = createRunner(process.execPath);
  const previous = process.env.BSK_BROWSER_WAIT_MS;
  const result = await run(["-e", "process.stdout.write(JSON.stringify({wait:process.env.BSK_BROWSER_WAIT_MS,path:!!(process.env.PATH||process.env.Path)}))"], { timeoutMs: 5000, env: { BSK_BROWSER_WAIT_MS: "0" } });
  assert.deepEqual(JSON.parse(result.stdout), { wait: "0", path: true });
  assert.equal(process.env.BSK_BROWSER_WAIT_MS, previous);
  await assert.rejects(run(["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }), { code: "BSK_TIMEOUT" });
});

test("等待预算拒绝零、负数、无穷、非整数和超过五分钟", async (t) => {
  const { home } = await fixture(t);
  for (const timeout of [0, -1, NaN, Infinity, 1.5, 300001]) {
    await assert.rejects(ensureOnline(home, async () => { assert.fail("不应查询"); }, "work", timeout), { code: "INVALID_TIMEOUT" });
  }
});
