import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { bindAccount, checkAccounts, createRunner, doctor, parseBrowsers, readStore } from "../src/core.ts";
import type { Account, Browser, Runner } from "../src/core.ts";
import type { LaunchConfig } from "../src/launch.ts";
import type { ChildLike, SpawnLike } from "../src/power-save.ts";

/** 防休眠的系统调用替身：记录拉起过什么、被 kill 了几次。 */
function fakeInhibit(): { spawn: SpawnLike; started: string[][]; killed: () => number } {
  const started: string[][] = [];
  let kills = 0;
  const spawn: SpawnLike = (command, args) => {
    started.push([command, ...args]);
    const listeners = new Map<string, (arg?: unknown) => void>();
    const child: ChildLike = {
      exitCode: null,
      kill: () => {
        kills += 1;
        return true;
      },
      on: (event, listener) => {
        listeners.set(event, listener);
        return child;
      },
    };
    return child;
  };
  return { spawn, started, killed: () => kills };
}

const edge: Browser = {
  instance_id: "1234abcd", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "工作账号", extension_protocol_version: "1.1", version_skew: false,
};
const binding = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "router-user-1" };
function mock(browsers: Browser[] = [edge]): Runner {
  return async (args) => {
    assert.deepEqual(args, ["browsers", "--json"]);
    return { stdout: JSON.stringify(browsers), exitCode: 0 };
  };
}
async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

for (const [name, payload] of [
  ["无效 JSON", "not-json"],
  ["错误的 RPC 包装", JSON.stringify({ browsers: [edge] })],
  ["缺失协议字段", JSON.stringify([{ instance_id: "1234abcd" }])],
  ["重复实例", JSON.stringify([edge, edge])],
]) {
  test(`拒绝${name}`, () => assert.throws(() => parseBrowsers(payload)));
}

test("列出多个浏览器且保留精确实例身份", async (t) => {
  const home = await temporary(t);
  const lines: string[] = [];
  const code = await main(["profiles", "list", "--json"], { home, run: mock([edge, { ...edge, instance_id: "abcd1234", browser_name: "Chrome" }]), launchDependencies: { launch: async () => { assert.fail("不应启动"); } }, output: (line) => lines.push(line) });
  assert.equal(code, 0);
  const report = JSON.parse(lines[0]);
  assert.equal(report.profiles[0].supported, true);
  assert.equal(report.profiles[1].supported, false);
});

test("绑定保存预期身份，不声称站点身份已验证", async (t) => {
  const home = await temporary(t);
  const lines: string[] = [];
  assert.equal(await main(["accounts", "bind", "work", "--instance-id", edge.instance_id, "--expected-identity", "router-user-1", "--confirm", "--json"], { home, run: mock(), launchDependencies: { launch: async () => { assert.fail("不应启动"); } }, output: (line) => lines.push(line) }), 0);
  assert.equal(JSON.parse(lines[0]).identity, "not_verified");
  const store = await readStore(home);
  assert.equal(store.accounts[0].instanceId, edge.instance_id);
  assert.equal(store.accounts[0].expectedIdentity, "router-user-1");
});

test("未确认不调用 bsk，不写入绑定", async (t) => {
  const home = await temporary(t);
  await assert.rejects(bindAccount(home, async () => { throw new Error("不应调用"); }, binding, false), { code: "CONFIRM_REQUIRED" });
  assert.deepEqual((await readStore(home)).accounts, []);
});

test("标签恰好等于目标 ID 时不回退到该浏览器", async (t) => {
  const home = await temporary(t);
  const other = { ...edge, instance_id: "eeee1111", label: edge.instance_id };
  await assert.rejects(bindAccount(home, mock([other]), binding, true), { code: "INSTANCE_OFFLINE" });
});

for (const extension_protocol_version of ["1.0", "1.1", "1.3"]) {
  test(`协议 ${extension_protocol_version} 可绑定且 check 在线`, async (t) => {
    const home = await temporary(t);
    const run = mock([{ ...edge, extension_protocol_version }]);
    await bindAccount(home, run, binding, true);
    assert.equal((await readStore(home)).accounts[0].instanceId, edge.instance_id);
    const result = await checkAccounts(home, run);
    assert.equal(result.ok, true);
    assert.equal(result.accounts[0].connection, "online");
    assert.equal(result.accounts[0].identity, "not_verified");
  });
}

const unsupportedProtocols = ["", "1.2", "1.4", "1.9", "2.0", "1.30", "1.3.0", " 1.3", "1.3 ", "v1.3", "1.3-beta"];

test("绑定仅允许 Edge 和已支持协议", async (t) => {
  const home = await temporary(t);
  await assert.rejects(bindAccount(home, mock([{ ...edge, browser_name: "Chrome" }]), binding, true), { code: "NOT_EDGE" });
  for (const extension_protocol_version of unsupportedProtocols) {
    await assert.rejects(bindAccount(home, mock([{ ...edge, extension_protocol_version }]), binding, true), { code: "UNSUPPORTED_PROTOCOL", message: /当前仅支持 1\.0 \/ 1\.1 \/ 1\.3。/ });
  }
  assert.deepEqual((await readStore(home)).accounts, []);
});

test("重复别名或重复实例绑定不覆盖原数据", async (t) => {
  const home = await temporary(t);
  await bindAccount(home, mock(), binding, true);
  const original = await readFile(join(home, "accounts.json"), "utf8");
  await assert.rejects(bindAccount(home, mock(), { ...binding, alias: "other" }, true), { code: "BINDING_EXISTS" });
  const other = { ...edge, instance_id: "eeee1111" };
  await assert.rejects(bindAccount(home, mock([other]), { ...binding, instanceId: other.instance_id }, true), { code: "BINDING_EXISTS" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), original);
});

test("改标签和重新读取持久化数据不影响绑定", async (t) => {
  const home = await temporary(t);
  await bindAccount(home, mock(), binding, true);
  const result = await checkAccounts(home, mock([{ ...edge, label: "已改名" }]));
  assert.equal(result.ok, true);
  assert.equal(result.accounts[0].currentLabel, "已改名");
  assert.equal(result.accounts[0].identity, "not_verified");
});

test("实例 ID 改变即离线，即使标签保持原值也不重新认领", async (t) => {
  const home = await temporary(t);
  await bindAccount(home, mock(), binding, true);
  const result = await checkAccounts(home, mock([{ ...edge, instance_id: "eeee1111" }]));
  assert.equal(result.ok, false);
  assert.equal(result.accounts[0].connection, "offline");
});

test("两个账号中一个离线时不选择另一个", async (t) => {
  const home = await temporary(t);
  const other = { ...edge, instance_id: "eeee1111" };
  await bindAccount(home, mock(), binding, true);
  await bindAccount(home, mock([other]), { alias: "personal", instanceId: other.instance_id, expectedIdentity: "router-user-2" }, true);
  const result = await checkAccounts(home, mock([other]));
  assert.deepEqual(result.accounts.map((item) => item.connection), ["offline", "online"]);
  assert.equal(result.ok, false);
});

test("连接使用错误浏览器或未知协议时失败", async (t) => {
  const home = await temporary(t);
  await bindAccount(home, mock(), binding, true);
  assert.equal((await checkAccounts(home, mock([{ ...edge, browser_name: "Chrome" }]))).accounts[0].connection, "wrong_browser");
  for (const extension_protocol_version of unsupportedProtocols) {
    const result = await checkAccounts(home, mock([{ ...edge, extension_protocol_version }]));
    assert.equal(result.ok, false);
    assert.equal(result.accounts[0].connection, "unsupported_protocol");
  }
});

test("损坏、未来版本和重复配置均不覆盖", async (t) => {
  const home = await temporary(t);
  for (const raw of ["{broken", '{"version":2,"accounts":[]}', JSON.stringify({ version: 1, accounts: [{ ...binding, boundAt: new Date().toISOString() }, { ...binding, boundAt: new Date().toISOString() }] })]) {
    await writeFile(join(home, "accounts.json"), raw);
    await assert.rejects(bindAccount(home, mock(), binding, true), { code: "INVALID_STORE" });
    assert.equal(await readFile(join(home, "accounts.json"), "utf8"), raw);
  }
});

test("存在写锁时不修改账号文件", async (t) => {
  const home = await temporary(t);
  await mkdir(join(home, "accounts.lock"));
  await assert.rejects(bindAccount(home, mock(), binding, true), { code: "STORE_BUSY" });
});

test("并发绑定不会丢失已写入账号", async (t) => {
  const home = await temporary(t);
  const other = { ...edge, instance_id: "eeee1111" };
  const results = await Promise.allSettled([
    bindAccount(home, mock(), binding, true),
    bindAccount(home, mock([other]), { alias: "personal", instanceId: other.instance_id, expectedIdentity: "router-user-2" }, true),
  ]);
  const successes = results.filter((result) => result.status === "fulfilled").length;
  assert.ok(successes >= 1);
  assert.equal((await readStore(home)).accounts.length, successes);
  for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "STORE_BUSY");
});

test("无账号时返回未配置且不访问 bsk", async (t) => {
  const home = await temporary(t);
  const result = await checkAccounts(home, async () => { throw new Error("不应调用"); });
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_ACCOUNTS");
});

test("doctor 仅用帮助检查 CLI 能力，不假装验证 daemon 严格路由", async () => {
  const calls: string[][] = [];
  const report = await doctor(async (args) => {
    calls.push(args);
    const stdout = args[0] === "--version" ? "bsk 0.2.3" : args[0] === "session" ? "--browser-id <ID>" : JSON.stringify([{ name: "protocol", status: "ok", detail: "1.1" }]);
    return { stdout, exitCode: 0 };
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((item) => item.name === "strict_id_daemon")?.status, "na");
  assert.deepEqual(calls, [["--version"], ["session", "start", "--help"], ["doctor", "--json"]]);
});

test("doctor 显示缺少 strict CLI、诊断失败与不可用进程", async () => {
  assert.equal((await doctor(async (args) => ({ stdout: args[0] === "doctor" ? JSON.stringify([{ name: "protocol", status: "fail", detail: "不兼容" }]) : "旧 bsk", exitCode: args[0] === "doctor" ? 1 : 0 }))).ok, false);
  assert.equal((await doctor(async () => { throw new Error("不可用"); })).ok, false);
});

test("非法参数和空白 ID 在执行命令前被拒绝", async (t) => {
  const home = await temporary(t);
  for (const args of [["accounts", "bind", "work", "--instance-id", " ", "--expected-identity", "user", "--confirm"], ["profiles", "list", "--confirm"], ["accounts", "check", "extra"], ["profiles", "list", "--unknown"]]) {
    assert.equal(await main([...args, "--json"], { home, run: async () => { throw new Error("不应调用"); }, launchDependencies: { launch: async () => { assert.fail("不应启动"); } }, output: () => {} }), 1);
  }
});

test("帮助不调用浏览器", async (t) => {
  const home = await temporary(t);
  const lines: string[] = [];
  assert.equal(await main(["--help"], { home, run: async () => { throw new Error("不应调用"); }, launchDependencies: { launch: async () => { assert.fail("不应启动"); } }, output: (line) => lines.push(line) }), 0);
  assert.match(lines[0], /不执行签到/);
});

test("子进程参数不经过 shell，包含空格和符号也保持原值", async () => {
  const run = createRunner(process.execPath);
  const result = await run(["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a b", "$(unsafe); &"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["a b", "$(unsafe); &"]);
});

test("不存在的可执行文件返回明确错误", async () => {
  await assert.rejects(createRunner(join(tmpdir(), "zenx-no-such-executable-940158.exe"))(["--version"]), { code: "BSK_UNAVAILABLE" });
});

async function launchFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await temporary(t);
  const config: LaunchConfig = { edgePath: join(home, "msedge.exe"), userDataDir: join(home, "User Data"), profileDirectory: "Profile 3" };
  const account: Account = { ...binding, boundAt: "2026-09-13T00:00:00.000Z" };
  await mkdir(join(config.userDataDir, config.profileDirectory), { recursive: true });
  await writeFile(config.edgePath, "模拟文件，不可执行");
  await writeFile(join(config.userDataDir, config.profileDirectory, "Preferences"), "{}");
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [account] }));
  return { home, config, account };
}

const windows = { skip: process.platform !== "win32" };

test("CLI configure-launch 保存明确路径到临时账号文件，不查询或启动浏览器", windows, async (t) => {
  const { home, config, account } = await launchFixture(t);
  const lines: string[] = [];
  let runs = 0;
  let launches = 0;
  const code = await main([
    "accounts", "configure-launch", "work", "--edge-path", config.edgePath,
    "--user-data-dir", config.userDataDir, "--profile-directory", config.profileDirectory, "--confirm", "--json",
  ], {
    home, output: (line) => lines.push(line),
    run: async () => { runs++; return { stdout: "[]", exitCode: 0 }; },
    launchDependencies: { launch: async () => { launches++; } },
  });
  assert.equal(code, 0);
  assert.equal(runs, 0);
  assert.equal(launches, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ok: true, account: { ...account, launch: config }, identity: "not_verified", dataDirectory: home });
  assert.deepEqual(JSON.parse(await readFile(join(home, "accounts.json"), "utf8")), { version: 1, accounts: [{ ...account, launch: config }] });
  assert.equal(await readFile(config.edgePath, "utf8"), "模拟文件，不可执行");
  assert.equal(await readFile(join(config.userDataDir, config.profileDirectory, "Preferences"), "utf8"), "{}");
});

const launchOptions = ["--edge-path", "C:\\Edge\\msedge.exe", "--user-data-dir", "C:\\User Data", "--profile-directory", "Profile 3"];
const invalidLaunchCommands: { name: string; args: string[]; code: string }[] = [
  { name: "configure-launch 无 confirm", args: ["accounts", "configure-launch", "work", ...launchOptions], code: "CONFIRM_REQUIRED" },
  { name: "configure-launch 未知 alias", args: ["accounts", "configure-launch", "unknown", ...launchOptions, "--confirm"], code: "ACCOUNT_NOT_FOUND" },
  { name: "ensure-online 未知 alias", args: ["accounts", "ensure-online", "unknown"], code: "ACCOUNT_NOT_FOUND" },
  { name: "configure-launch 缺 alias", args: ["accounts", "configure-launch", ...launchOptions, "--confirm"], code: "INVALID_ARGUMENT" },
  { name: "ensure-online 缺 alias", args: ["accounts", "ensure-online"], code: "INVALID_ARGUMENT" },
  { name: "configure-launch 无关 timeout", args: ["accounts", "configure-launch", "work", ...launchOptions, "--confirm", "--timeout", "1s"], code: "INVALID_ARGUMENT" },
  { name: "configure-launch 无关 instance-id", args: ["accounts", "configure-launch", "work", ...launchOptions, "--confirm", "--instance-id", edge.instance_id], code: "INVALID_ARGUMENT" },
  { name: "ensure-online 无关 confirm", args: ["accounts", "ensure-online", "work", "--confirm"], code: "INVALID_ARGUMENT" },
  { name: "ensure-online 无关 edge-path", args: ["accounts", "ensure-online", "work", "--edge-path", launchOptions[1]], code: "INVALID_ARGUMENT" },
  { name: "relink-account 无 confirm", args: ["accounts", "relink-account", "work"], code: "CONFIRM_REQUIRED" },
  { name: "relink-account 缺 alias", args: ["accounts", "relink-account", "--confirm"], code: "INVALID_ARGUMENT" },
  { name: "relink-account 无关 tab-id", args: ["accounts", "relink-account", "work", "--confirm", "--tab-id", "1"], code: "INVALID_ARGUMENT" },
  { name: "relink-account 非法 timeout", args: ["accounts", "relink-account", "work", "--confirm", "--timeout", "0s"], code: "INVALID_TIMEOUT" },
  { name: "已移除的 relink-profile 不再接受", args: ["accounts", "relink-profile", "work", "--confirm"], code: "INVALID_ARGUMENT" },
  { name: "check 无关 timeout", args: ["accounts", "check", "--timeout", "1s"], code: "INVALID_ARGUMENT" },
  { name: "configure-launch 重复 edge-path", args: ["accounts", "configure-launch", "work", ...launchOptions, "--edge-path=C:\\Other\\msedge.exe", "--confirm"], code: "INVALID_ARGUMENT" },
  { name: "ensure-online 重复 timeout", args: ["accounts", "ensure-online", "work", "--timeout", "1s", "--timeout=2s"], code: "INVALID_ARGUMENT" },
  { name: "close 无 confirm", args: ["accounts", "close", "work"], code: "CONFIRM_REQUIRED" },
  { name: "close 缺 alias", args: ["accounts", "close", "--confirm"], code: "INVALID_ARGUMENT" },
  { name: "close 未知 alias", args: ["accounts", "close", "unknown", "--confirm"], code: "ACCOUNT_NOT_FOUND" },
  { name: "close 无关 tab-id", args: ["accounts", "close", "work", "--confirm", "--tab-id", "1"], code: "INVALID_ARGUMENT" },
];
for (const option of ["--edge-path", "--user-data-dir", "--profile-directory"]) {
  invalidLaunchCommands.push({
    name: `configure-launch 缺 ${option}`,
    args: ["accounts", "configure-launch", "work", ...launchOptions.filter((_, index) => index !== launchOptions.indexOf(option) && index !== launchOptions.indexOf(option) + 1), "--confirm"],
    code: "INVALID_LAUNCH_CONFIG",
  });
}
for (const value of ["0ms", "0s", "-1s", "301s", "300001ms", "6m", "45", "1.5s", "1h"]) {
  invalidLaunchCommands.push({ name: `ensure-online 非法 timeout ${value}`, args: ["accounts", "ensure-online", "work", `--timeout=${value}`], code: "INVALID_TIMEOUT" });
}
for (const { name, args, code: errorCode } of invalidLaunchCommands) {
  test(`CLI ${name} 不查询、不启动、不修改账号`, async (t) => {
    const { home } = await launchFixture(t);
    const before = await readFile(join(home, "accounts.json"), "utf8");
    const lines: string[] = [];
    let runs = 0;
    let launches = 0;
    const code = await main([...args, "--json"], {
      home, output: (line) => lines.push(line),
      run: async () => { runs++; return { stdout: JSON.stringify([edge]), exitCode: 0 }; },
      launchDependencies: { launch: async () => { launches++; } },
    });
    assert.equal(code, 1);
    assert.equal(runs, 0);
    assert.equal(launches, 0);
    assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]);
    assert.equal(report.ok, false);
    assert.equal(report.error.code, errorCode);
    assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
  });
}

test("CLI ensure-online 在线无需配置，不启动且默认查询预算为 45s", async (t) => {
  const { home } = await launchFixture(t);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  const lines: string[] = [];
  let runs = 0;
  let launches = 0;
  const code = await main(["accounts", "ensure-online", "work", "--json"], {
    home, output: (line) => lines.push(line),
    run: async (args, options) => {
      runs++;
      assert.deepEqual(args, ["browsers", "--json"]);
      assert.deepEqual(options, { timeoutMs: 45_000, env: { BSK_BROWSER_WAIT_MS: "0" } });
      return { stdout: JSON.stringify([edge]), exitCode: 0 };
    },
    launchDependencies: { now: () => 1000, launch: async () => { launches++; } },
  });
  assert.equal(code, 0);
  assert.equal(runs, 1);
  assert.equal(launches, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ok: true, alias: "work", instanceId: edge.instance_id, connection: "online", launched: false, identity: "not_verified" });
  assert.equal((await readStore(home)).accounts[0].launch, undefined);
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

const closeReply = JSON.stringify({ browser_id: edge.instance_id, closed: true, windows_closed: 2, sessions_stopped: 1, disconnected: false });

test("CLI accounts close 按精确实例 ID 关闭，不启动也不改绑定", async (t) => {
  const { home } = await launchFixture(t);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  const lines: string[] = [];
  const calls: string[][] = [];
  let launches = 0;
  const code = await main(["accounts", "close", "work", "--confirm", "--json"], {
    home, output: (line) => lines.push(line),
    run: async (args, options) => {
      calls.push(args);
      if (args[1] === "close") {
        assert.deepEqual(options, { timeoutMs: 45_000 });
        return { stdout: closeReply, exitCode: 0 };
      }
      assert.deepEqual(options, { timeoutMs: 45_000, env: { BSK_BROWSER_WAIT_MS: "0" } });
      return { stdout: JSON.stringify([edge]), exitCode: 0 };
    },
    launchDependencies: { now: () => 1000, launch: async () => { launches++; } },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["browsers", "--json"],
    ["browsers", "close", "--browser-id", edge.instance_id, "--confirm", "--json"],
  ]);
  assert.equal(launches, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    ok: true, alias: "work", instanceId: edge.instance_id, browser_id: edge.instance_id,
    closed: true, windows_closed: 2, sessions_stopped: 1, disconnected: false, identity: "not_verified",
  });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

for (const [timeout, budget] of [["1500ms", 1500], ["2s", 2000], ["1m", 60_000], ["5m", 300_000]] as const) {
  test(`CLI ensure-online --timeout ${timeout} 按单位计时，离线只模拟启动一次`, windows, async (t) => {
    const { home, config, account } = await launchFixture(t);
    await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [{ ...account, launch: config }] }));
    const before = await readFile(join(home, "accounts.json"), "utf8");
    const lines: string[] = [];
    const budgets: number[] = [];
    const sleeps: number[] = [];
    const launched: LaunchConfig[] = [];
    let now = 0;
    let runs = 0;
    const code = await main(["accounts", "ensure-online", "work", "--timeout", timeout, "--json"], {
      home, output: (line) => lines.push(line),
      run: async (args, options) => {
        assert.deepEqual(args, ["browsers", "--json"]);
        assert.equal(options?.env?.BSK_BROWSER_WAIT_MS, "0");
        budgets.push(options!.timeoutMs!);
        now += 100;
        return { stdout: JSON.stringify(++runs === 3 ? [edge] : []), exitCode: 0 };
      },
      launchDependencies: {
        platform: "win32", now: () => now,
        sleep: async (ms) => { sleeps.push(ms); now += ms; },
        launch: async (value) => { launched.push(value); },
      },
    });
    assert.equal(code, 0);
    assert.equal(runs, 3);
    assert.deepEqual(launched, [config]);
    assert.deepEqual(budgets, [budget, budget - 100, budget - 700].map((value) => Math.min(60_000, value)));
    assert.deepEqual(sleeps, [500]);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { ok: true, alias: "work", instanceId: edge.instance_id, connection: "online", launched: true, identity: "not_verified" });
    assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
  });
}

test("CLI ensure-online 1ms 下限按总预算超时，不接受迟到在线结果也不启动", async (t) => {
  const { home } = await launchFixture(t);
  const lines: string[] = [];
  let now = 0;
  let runs = 0;
  let launches = 0;
  const code = await main(["accounts", "ensure-online", "work", "--timeout", "1ms", "--json"], {
    home, output: (line) => lines.push(line),
    run: async (args, options) => {
      runs++;
      assert.deepEqual(args, ["browsers", "--json"]);
      assert.equal(options?.timeoutMs, 1);
      now += 1;
      return { stdout: JSON.stringify([edge]), exitCode: 0 };
    },
    launchDependencies: { now: () => now, launch: async () => { launches++; } },
  });
  assert.equal(code, 1);
  assert.equal(runs, 1);
  assert.equal(launches, 0);
  assert.equal(JSON.parse(lines[0]).error.code, "PROFILE_CONNECT_TIMEOUT");
});

test("CLI accounts check 即使离线且有启动配置仍只读，不自动启动", windows, async (t) => {
  const { home, config, account } = await launchFixture(t);
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [{ ...account, launch: config }] }));
  const before = await readFile(join(home, "accounts.json"), "utf8");
  const lines: string[] = [];
  let runs = 0;
  let launches = 0;
  const code = await main(["accounts", "check", "--json"], {
    home, output: (line) => lines.push(line),
    run: async (args) => {
      runs++;
      assert.deepEqual(args, ["browsers", "--json"]);
      return { stdout: "[]", exitCode: 0 };
    },
    launchDependencies: { launch: async () => { launches++; } },
  });
  assert.equal(code, 1);
  assert.equal(runs, 1);
  assert.equal(launches, 0);
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.equal(report.ok, false);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].alias, "work");
  assert.equal(report.accounts[0].instanceId, edge.instance_id);
  assert.equal(report.accounts[0].connection, "offline");
  assert.equal(report.accounts[0].identity, "not_verified");
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

// 防休眠接在 CLI 层：批量签到内部再调单账号签到时不会重复激活。
// 账号离线即可让 checkin 在前置检查处早退，不必搭完整页面流程。
async function offlineCheckin(t: { after: (fn: () => Promise<void>) => void }, args: string[]) {
  const home = await temporary(t);
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [binding] }));
  const lines: string[] = [];
  const inhibit = fakeInhibit();
  const code = await main(["accounts", "checkin", binding.alias, ...args], {
    home,
    output: (line) => lines.push(line),
    run: async () => ({ stdout: "[]", exitCode: 0 }),
    inhibitSpawn: inhibit.spawn,
  });
  return { code, lines, inhibit };
}

test("CLI checkin 默认开启防休眠并在结束后释放", async (t) => {
  const { inhibit } = await offlineCheckin(t, ["--json"]);
  assert.equal(inhibit.started.length, 1, "签到前激活一次");
  assert.equal(inhibit.killed(), 1, "签到后必定释放");
});

test("CLI checkin --inhibit-sleep no 完全不拉起防休眠", async (t) => {
  const { inhibit, lines } = await offlineCheckin(t, ["--json", "--inhibit-sleep", "no"]);
  assert.equal(inhibit.started.length, 0);
  assert.equal(inhibit.killed(), 0);
  assert.doesNotMatch(lines.join("\n"), /防休眠/);
});

test("CLI checkin 人类输出记录防休眠，--json 不污染报告", async (t) => {
  const plain = await offlineCheckin(t, []);
  assert.ok(plain.lines.some((line) => line.includes("防休眠已开启")), "要能看到开启与所用策略");
  assert.ok(plain.lines.some((line) => line.includes("防休眠已关闭")));
  const asJson = await offlineCheckin(t, ["--json"]);
  assert.equal(asJson.lines.filter((line) => line.includes("防休眠")).length, 0, "--json 只输出报告");
});

test("CLI checkin --inhibit-timeout 非法值被拒绝且不拉起子进程", async (t) => {
  const home = await temporary(t);
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [binding] }));
  const lines: string[] = [];
  const inhibit = fakeInhibit();
  const code = await main(["accounts", "checkin", binding.alias, "--inhibit-timeout", "25h", "--json"], {
    home,
    output: (line) => lines.push(line),
    run: async () => ({ stdout: "[]", exitCode: 0 }),
    inhibitSpawn: inhibit.spawn,
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(lines[0]).error.code, "INVALID_INHIBIT_TIMEOUT");
  assert.equal(inhibit.started.length, 0, "参数不合法就不该动系统状态");
});

// --- close-all / close-leftover ---

test("CLI close-all 与 close-leftover 都需要 --confirm", async (t) => {
  const home = await temporary(t);
  const lines: string[] = [];
  const run: Runner = () => Promise.reject(new Error("未确认就不该调用 bsk"));
  assert.equal(await main(["accounts", "close-all", "--json"], { home, run, output: (line) => lines.push(line) }), 1);
  assert.equal(JSON.parse(lines[0]).error.code, "CONFIRM_REQUIRED");
  assert.equal(await main(["accounts", "close-leftover", "--json"], { home, run, output: (line) => lines.push(line) }), 1);
  assert.equal(JSON.parse(lines[1]).error.code, "CONFIRM_REQUIRED");
});

test("CLI close-all 逐个关闭并汇总，失败不中断", async (t) => {
  const home = await temporary(t);
  await writeFile(join(home, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [
      { alias: "one", instanceId: "aaaa1111", expectedIdentity: "g1", boundAt: "2026-09-13T00:00:00Z" },
      { alias: "two", instanceId: "bbbb2222", expectedIdentity: "g2", boundAt: "2026-09-13T00:00:00Z" },
    ],
  }));
  const lines: string[] = [];
  const code = await main(["accounts", "close-all", "--confirm", "--json"], {
    home,
    output: (line) => lines.push(line),
    run: async (args) => {
      if (args[0] === "browsers" && args[1] === "close") {
        if (args[3] === "bbbb2222") return { stdout: "unknown_method: browser.close", exitCode: 1 };
        return { stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 2, sessions_stopped: 1, disconnected: true }), exitCode: 0 };
      }
      return { stdout: JSON.stringify([{ ...edge, instance_id: "aaaa1111" }, { ...edge, instance_id: "bbbb2222" }]), exitCode: 0 };
    },
  });
  assert.equal(code, 1, "有失败就返回 1");
  const report = JSON.parse(lines[0]);
  assert.equal(report.closed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.accounts[1].code, "CLOSE_NOT_SUPPORTED");
});

test("CLI close-leftover 只关追踪里的遗留实例并清除记录", async (t) => {
  const home = await temporary(t);
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [{ ...binding, boundAt: "2026-09-13T00:00:00Z" }] }));
  await writeFile(join(home, "leftover-instances.json"), JSON.stringify({
    version: 1,
    updatedAt: "",
    instances: [{ alias: "work", instanceId: "1234abcd", launchedAt: "2026-09-24T00:00:00Z" }],
  }));
  const lines: string[] = [];
  const code = await main(["accounts", "close-leftover", "--confirm", "--json"], {
    home,
    output: (line) => lines.push(line),
    run: async (args) => {
      if (args[0] === "browsers" && args[1] === "close") {
        return { stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 };
      }
      return { stdout: JSON.stringify([edge]), exitCode: 0 };
    },
  });
  assert.equal(code, 0);
  const report = JSON.parse(lines[0]);
  assert.equal(report.tracked, 1);
  assert.equal(report.closed, 1);
  const state = JSON.parse(await readFile(join(home, "leftover-instances.json"), "utf8"));
  assert.deepEqual(state.instances, [], "关闭确认后记录应清除");
});

test("CLI checkin-all 接受 --close-leftover 并在报告里汇总", async (t) => {
  const home = await temporary(t);
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [] }));
  const lines: string[] = [];
  const inhibit = fakeInhibit();
  const code = await main(["accounts", "checkin-all", "--close-leftover", "--json"], {
    home,
    output: (line) => lines.push(line),
    run: async () => ({ stdout: "[]", exitCode: 0 }),
    inhibitSpawn: inhibit.spawn,
  });
  assert.equal(code, 0);
  const report = JSON.parse(lines[0]);
  assert.deepEqual(report.leftoverCleanup, { tracked: 0, closed: 0, dropped: 0, failed: 0 });
});
