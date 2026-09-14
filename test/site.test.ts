import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { bindAccount, ZenxError } from "../src/core.ts";
import type { Account, Browser, Runner, Result } from "../src/core.ts";
import { configureLaunch, ensureOnline, inspectSite, openSite } from "../src/launch.ts";
import type { LaunchDependencies } from "../src/launch.ts";

const edge: Browser = {
  instance_id: "exact-instance", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "标签不是路由", extension_protocol_version: "1.1", version_skew: false,
};
const account: Account = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "private-identity", boundAt: "2026-09-13T00:00:00Z" };
const tab = (id = 11, url = "https://agentrouter.org/dashboard", active = false) => ({ tab_id: id, window_id: 5, title: "private-title", url, active, scope: "user" });
const reply = (value: unknown): Result => ({ stdout: JSON.stringify(value), exitCode: 0 });
const noLaunch: LaunchDependencies = { now: () => 0, launch: async () => { assert.fail("在线不得启动"); } };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-site-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = { edgePath: join(home, "msedge.exe"), userDataDir: join(home, "User Data"), profileDirectory: "Default" };
  await mkdir(join(config.userDataDir, config.profileDirectory), { recursive: true });
  await writeFile(config.edgePath, "模拟文件，不可执行");
  await writeFile(join(config.userDataDir, config.profileDirectory, "Preferences"), "不读取的私密内容");
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [account] }));
  return { home, config };
}
function runner(tabs: unknown[], mutate?: (args: string[]) => Promise<Result>) {
  const calls: string[][] = [];
  const run: Runner = async (args, options) => {
    calls.push(args);
    assert.equal(options?.env?.BSK_BROWSER_WAIT_MS, "0");
    if (args[0] === "browsers") { assert.deepEqual(args, ["browsers", "--json"]); return reply([edge]); }
    if (args[1] === "list") {
      assert.deepEqual(args, ["tab", "list", "--browser-id", edge.instance_id, "--scope", "user", "--json"]);
      return reply({ tabs });
    }
    assert.ok(["select", "create"].includes(args[1]));
    return mutate ? mutate(args) : reply({ tab_id: args[1] === "select" ? Number(args[2]) : 99, window_id: 5 });
  };
  return { run, calls };
}

for (const url of ["https://agentrouter.org/", "http://agentrouter.org/account", "https://AGENTROUTER.ORG:443/x", "http://agentrouter.org:80/x", "https://agentrouter.org?q=@private"]) {
  test(`唯一匹配复用并传实际 origin：${url}`, async (t) => {
    const { home } = await fixture(t);
    const before = await readFile(join(home, "accounts.json"), "utf8");
    const { run, calls } = runner([tab(11, url), tab(12, "https://unrelated.test/private", true)]);
    const result = await openSite(home, run, "work", undefined, 1000, noLaunch);
    assert.deepEqual(result, { ok: true, alias: "work", instanceId: edge.instance_id, action: "reused", tabId: 11, windowId: 5, identity: "not_verified", launched: false });
    assert.deepEqual(calls[2], ["tab", "select", "11", "--browser-id", edge.instance_id, "--expected-origin", new URL(url).origin, "--json"]);
    assert.equal(calls.length, 3);
    assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
    assert.ok(!(await readdir(home)).includes("accounts.lock"));
  });
}

test("多个候选只自动选择唯一 active，显式选择覆盖 active", async (t) => {
  const { home } = await fixture(t);
  for (const explicit of [undefined, 11]) {
    const { run, calls } = runner([tab(11), tab(12, "http://agentrouter.org/", true), tab(13, "https://elsewhere.test/", true)]);
    const result = await openSite(home, run, "work", explicit, 1000, noLaunch);
    assert.equal(result.tabId, explicit ?? 12);
    assert.equal(calls[2][1], "select");
  }
});

for (const active of [false, true]) {
  test(`多个候选 active=${active} 时返回候选 ID，不泄露 URL/title/身份`, async (t) => {
    const { home } = await fixture(t);
    const { run, calls } = runner([tab(11, "https://agentrouter.org/private?secret", active), tab(12, "https://agentrouter.org/", active), tab(13, "https://elsewhere.test/private")]);
    const lines: string[] = [];
    assert.equal(await main(["accounts", "open-site", "work", "--json"], { home, run, launchDependencies: noLaunch, output: (line) => lines.push(line) }), 1);
    const error = JSON.parse(lines[0]).error;
    assert.equal(error.code, "AMBIGUOUS_SITE_TABS");
    assert.deepEqual(error.candidateTabIds, [11, 12]);
    assert.match(error.message, /--tab-id/);
    assert.doesNotMatch(lines[0], /secret|private|elsewhere/);
    assert.equal(calls.length, 2);
  });
}

const unrelated = [
  "https://evil.test/?next=https://agentrouter.org/", "https://agentrouter.org.evil.test/",
  "https://sub.agentrouter.org/", "https://agentrouter.org@evil.test/", "https://evil@agentrouter.org/",
  "https://user:pass@agentrouter.org/", "https://@agentrouter.org/", "https://agentrouter.org:8443/",
  "https://agentrouter.org./", "ftp://agentrouter.org/", "about:blank", "edge://newtab/",
];
for (const tabs of [[], unrelated.map((url, i) => tab(i + 1, url))]) {
  test(`无匹配只创建固定网址（列表长度 ${tabs.length}）`, async (t) => {
    const { home } = await fixture(t);
    const { run, calls } = runner(tabs);
    const result = await openSite(home, run, "work", undefined, 1000, noLaunch);
    assert.equal(result.action, "created");
    assert.deepEqual(calls[2], ["tab", "create", "https://agentrouter.org/", "--browser-id", edge.instance_id, "--json"]);
    assert.equal(calls.length, 3);
  });
}

for (const tabs of [[], [tab(11)], [tab(99, "https://evil.test/")]]) {
  test(`显式选择非候选不得新建（列表长度 ${tabs.length}）`, async (t) => {
    const { home } = await fixture(t);
    const { run, calls } = runner(tabs);
    await assert.rejects(openSite(home, run, "work", 99, 1000, noLaunch), { code: "SITE_TAB_NOT_FOUND" });
    assert.equal(calls.length, 2);
  });
}

const invalidLists: [string, Result][] = [
  ["旧 CLI", { stdout: "unknown argument --scope", exitCode: 2 }],
  ["旧 daemon", { stdout: '{"error":{"message":"Method not found"}}', exitCode: 1 }],
  ["旧扩展", { stdout: '{"tabs":[]}', exitCode: 1 }],
  ["畸形", { stdout: "not-json", exitCode: 0 }],
  ["截断", { stdout: '{"tabs":[', exitCode: 0 }],
  ["部分列表标记", reply({ tabs: [], truncated: true })],
  ["错误包装", reply({ result: { tabs: [] } })],
  ["数组", reply([])], ["缺字段", reply({ tabs: [{}] })],
  ["非 user", reply({ tabs: [{ ...tab(), scope: "agent" }] })],
  ["混合 scope", reply({ tabs: [tab(), { ...tab(12), scope: "agent" }] })],
  ["重复 ID", reply({ tabs: [tab(), tab()] })],
  ["错误 active", reply({ tabs: [{ ...tab(), active: "true" }] })],
  ["负 ID", reply({ tabs: [{ ...tab(), tab_id: -1 }] })],
  ["错误 window", reply({ tabs: [{ ...tab(), window_id: null }] })],
  ["错误 URL", reply({ tabs: [tab(11, "not-a-url")] })],
];
for (const [name, payload] of invalidLists) {
  test(`列表 ${name} 不得视为空列表或触发 mutation`, async (t) => {
    const { home } = await fixture(t);
    let calls = 0;
    const run: Runner = async (args) => {
      calls++;
      if (args[0] === "browsers") return reply([edge]);
      assert.equal(args[1], "list");
      return payload;
    };
    await assert.rejects(openSite(home, run, "work", undefined, 1000, noLaunch), { code: payload.exitCode ? "BSK_FAILED" : "INVALID_BSK_OUTPUT" });
    assert.equal(calls, 2);
    assert.ok(!(await readdir(home)).includes("accounts.lock"));
  });
}

for (const create of [false, true]) {
  for (const [name, payload] of [
    ["旧组件拒绝", { stdout: "unsupported", exitCode: 1 }],
    ["畸形", { stdout: "bad", exitCode: 0 }],
    ["缺字段", reply({ tab_id: 11 })], ["无效 ID", reply({ tab_id: 0, window_id: 5 })],
    ["错误包装", reply({ result: { tab_id: 11, window_id: 5 } })],
    ["结果有错误标记", reply({ tab_id: 11, window_id: 5, error: "unknown" })],
  ] as [string, Result][]) {
    test(`${create ? "创建" : "切换"} ${name} 后不重试且提示可能生效`, async (t) => {
      const { home } = await fixture(t);
      const { run, calls } = runner(create ? [] : [tab()], async () => payload);
      await assert.rejects(openSite(home, run, "work", undefined, 1000, noLaunch), { code: "SITE_MUTATION_UNCERTAIN", message: /可能已生效/ });
      assert.equal(calls.length, 3);
      assert.ok(!(await readdir(home)).includes("accounts.lock"));
    });
  }
  test(`${create ? "创建" : "切换"} 超时/抛错/迟到均只 mutation 一次`, async (t) => {
    const { home } = await fixture(t);
    for (const kind of ["timeout", "late", "error"]) {
      let now = 0;
      const { run, calls } = runner(create ? [] : [tab()], async () => {
        if (kind === "timeout") throw new ZenxError("BSK_TIMEOUT", "private-message");
        if (kind === "error") throw new Error("private-message");
        now = 1000;
        return reply({ tab_id: 11, window_id: 5 });
      });
      await assert.rejects(openSite(home, run, "work", undefined, 1000, { ...noLaunch, now: () => now }), { code: "SITE_MUTATION_UNCERTAIN", message: /可能已生效/ });
      assert.equal(calls.length, 3);
    }
  });
}

test("切换回复不同 tab ID 不接受也不新建", async (t) => {
  const { home } = await fixture(t);
  const { run, calls } = runner([tab()], async () => reply({ tab_id: 12, window_id: 5 }));
  await assert.rejects(openSite(home, run, "work", undefined, 1000, noLaunch), { code: "SITE_MUTATION_UNCERTAIN" });
  assert.equal(calls.length, 3);
});

test("列表超时或返回时已耗尽预算不创建；连接和后续不续期", async (t) => {
  const { home } = await fixture(t);
  for (const mode of ["late", "timeout", "success"]) {
    let now = 0;
    const budgets: number[] = [];
    const calls: string[][] = [];
    const run: Runner = async (args, options) => {
      calls.push(args);
      budgets.push(options!.timeoutMs!);
      if (args[0] === "browsers") { now += 200; return reply([edge]); }
      if (args[1] === "list") {
        if (mode === "timeout") throw new ZenxError("BSK_TIMEOUT", "模拟查询超时");
        now += mode === "late" ? 800 : 300;
        return reply({ tabs: [] });
      }
      return reply({ tab_id: 99, window_id: 5 });
    };
    const operation = openSite(home, run, "work", undefined, 1000, { ...noLaunch, now: () => now });
    if (mode === "success") { assert.equal((await operation).action, "created"); assert.deepEqual(budgets, [1000, 800, 500]); }
    else { await assert.rejects(operation, { code: mode === "late" ? "SITE_TIMEOUT" : "BSK_TIMEOUT" }); assert.equal(calls.length, 2); }
  }
});

test("离线启动一次，恢复连接后仍共用预算且不生成 session", { skip: process.platform !== "win32" }, async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  let now = 0;
  let launches = 0;
  let queries = 0;
  const budgets: number[] = [];
  const run: Runner = async (args, options) => {
    budgets.push(options!.timeoutMs!);
    now += 100;
    if (args[0] === "browsers") return reply(++queries === 3 ? [edge] : [{ ...edge, instance_id: "other-id", label: edge.instance_id }]);
    if (args[1] === "list") return reply({ tabs: [] });
    assert.deepEqual(args, ["tab", "create", "https://agentrouter.org/", "--browser-id", edge.instance_id, "--json"]);
    return reply({ tab_id: 99, window_id: 5 });
  };
  const result = await openSite(home, run, "work", undefined, 2000, {
    now: () => now, sleep: async (ms) => { now += ms; },
    launch: async (value) => { launches++; now += 100; assert.deepEqual(value, config); },
  });
  assert.equal(result.launched, true);
  assert.equal(launches, 1);
  assert.deepEqual(budgets, [2000, 1800, 1200, 1100, 1000]);
});

for (const stage of ["browsers", "list", "select"]) {
  test(`整个 ${stage} 阶段持锁，阻止 open/ensure/configure/bind 并在 finally 释放`, async (t) => {
    const { home } = await fixture(t);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mock = runner([tab()]);
    const first = openSite(home, async (args, options) => {
      if ((args[0] === "browsers" ? "browsers" : args[1]) === stage) { entered.resolve(); await release.promise; }
      return mock.run(args, options);
    }, "work", undefined, 1000, noLaunch);
    await entered.promise;
    const fail: Runner = async () => { assert.fail("锁内不得开始另一次查询"); };
    try {
      await assert.rejects(openSite(home, fail, "work", undefined, 1000, noLaunch), { code: "STORE_BUSY" });
      await assert.rejects(ensureOnline(home, fail, "work", 1000, noLaunch), { code: "STORE_BUSY" });
      await assert.rejects(configureLaunch(home, "work", { edgePath: "C:\\Edge\\msedge.exe", userDataDir: "C:\\Data", profileDirectory: "Default" }, true), { code: "STORE_BUSY" });
      await assert.rejects(bindAccount(home, fail, { alias: "other", instanceId: "another", expectedIdentity: "other" }, true), { code: "STORE_BUSY" });
    } finally { release.resolve(); }
    assert.equal((await first).action, "reused");
    assert.ok(!(await readdir(home)).includes("accounts.lock"));
  });
}

test("协议 2.x 或错误实例不执行用户标签命令，不按 label 回退", async (t) => {
  const { home } = await fixture(t);
  for (const [browser, code] of [[{ ...edge, extension_protocol_version: "2.0" }, "UNSUPPORTED_PROTOCOL"], [{ ...edge, instance_id: "other", label: edge.instance_id }, "LAUNCH_NOT_CONFIGURED"]] as const) {
    await assert.rejects(openSite(home, async (args) => { assert.deepEqual(args, ["browsers", "--json"]); return reply([browser]); }, "work", undefined, 1000, noLaunch), { code });
  }
});

const invalidCommands: [string[], string][] = [
  [["accounts", "open-site"], "INVALID_ARGUMENT"],
  [["accounts", "open-site", "unknown"], "ACCOUNT_NOT_FOUND"],
  [["accounts", "open-site", "work", "https://evil.test"], "INVALID_ARGUMENT"],
  [["accounts", "open-site", "work", "--confirm"], "INVALID_ARGUMENT"],
  [["accounts", "open-site", "work", "--instance-id", "other"], "INVALID_ARGUMENT"],
  [["accounts", "ensure-online", "work", "--tab-id", "11"], "INVALID_ARGUMENT"],
  [["profiles", "list", "--tab-id", "11"], "INVALID_ARGUMENT"],
  [["accounts", "open-site", "work", "--tab-id", "11", "--tab-id", "12"], "INVALID_ARGUMENT"],
  [["accounts", "open-site", "work", "--timeout", "1s", "--timeout", "2s"], "INVALID_ARGUMENT"],
];
for (const value of ["0", "-1", "1.5", "1e2", "0x10", "+1", "01", " 1", "1 ", "2147483648", "9007199254740993", "", "NaN", "Infinity"]) {
  invalidCommands.push([["accounts", "open-site", "work", `--tab-id=${value}`], "INVALID_TAB_ID"]);
}
for (const value of ["0ms", "1.5s", "301s", "6m", "1", "-1s"]) {
  invalidCommands.push([["accounts", "open-site", "work", `--timeout=${value}`], "INVALID_TIMEOUT"]);
}
for (const [args, code] of invalidCommands) {
  test(`CLI 拒绝 ${args.join(" ")}`, async (t) => {
    const { home } = await fixture(t);
    const lines: string[] = [];
    assert.equal(await main([...args, "--json"], { home, run: async () => { assert.fail("非法参数不得调用 bsk"); }, launchDependencies: noLaunch, output: (line) => lines.push(line) }), 1);
    assert.equal(JSON.parse(lines[0]).error.code, code);
  });
}

test("CLI open-site 默认预算及严格显式 tab ID，输出不含私密信息", async (t) => {
  const { home } = await fixture(t);
  for (const [timeoutArgs, budget] of [[[], 45000], [["--timeout", "1500ms"], 1500], [["--timeout", "5m"], 60000]] as [string[], number][]) {
    const lines: string[] = [];
    const mock = runner([tab(2147483647)]);
    assert.equal(await main(["accounts", "open-site", "work", "--tab-id", "2147483647", ...timeoutArgs, "--json"], {
      home, launchDependencies: noLaunch, output: (line) => lines.push(line),
      run: async (args, options) => { assert.equal(options?.timeoutMs, budget); return mock.run(args, options); },
    }), 0);
    assert.deepEqual(JSON.parse(lines[0]), { ok: true, alias: "work", instanceId: edge.instance_id, action: "reused", tabId: 2147483647, windowId: 5, identity: "not_verified", launched: false });
  }
});

test("CLI help 解释不显式启动空白窗口和不确定请求不重试", async () => {
  const lines: string[] = [];
  assert.equal(await main(["--help"], { output: (line) => lines.push(line), run: async () => { assert.fail("不调用 bsk"); } }), 0);
  assert.match(lines[0], /accounts open-site/);
  assert.match(lines[0], /accounts inspect-site/);
  assert.match(lines[0], /不启动 Edge、不切换\/新建\/刷新标签/);
  assert.match(lines[0], /人工刷新该标签后重试/);
  assert.match(lines[0], /不显式打开空白窗口/);
  assert.match(lines[0], /Edge 自身启动设置/);
  assert.match(lines[0], /共用总预算/);
  assert.match(lines[0], /不自动重试/);
});

// ---------- inspect-site：只读预检 ----------

const observed = (text: string, over: Record<string, unknown> = {}) => ({
  browser_id: edge.instance_id, tab_id: 11, window_id: 5, origin: "https://agentrouter.org",
  document_id: "doc-1", text, truncated: false, ...over,
});
function inspectRunner(tabs: unknown[], observe?: (args: string[]) => Promise<Result>, browsers: Browser[] = [edge]) {
  const calls: string[][] = [];
  const run: Runner = async (args, options) => {
    calls.push(args);
    assert.equal(options?.env?.BSK_BROWSER_WAIT_MS, "0");
    if (args[0] === "browsers") { assert.deepEqual(args, ["browsers", "--json"]); return reply(browsers); }
    if (args[1] === "list") {
      assert.deepEqual(args, ["tab", "list", "--browser-id", edge.instance_id, "--scope", "user", "--json"]);
      return reply({ tabs });
    }
    assert.equal(args[1], "observe");
    return observe ? observe(args) : reply(observed("未登录页面", { tab_id: Number(args[5]) }));
  };
  return { run, calls };
}

test("inspect 离线或协议不符直接报告，不启动、不查询标签、不持锁", async (t) => {
  const { home } = await fixture(t);
  for (const [browsers, connection] of [
    [[{ ...edge, instance_id: "other" }], "offline"],
    [[{ ...edge, browser_name: "Chrome" }], "wrong_browser"],
    [[{ ...edge, extension_protocol_version: "2.0" }], "unsupported_protocol"],
  ] as [Browser[], string][]) {
    const { run, calls } = inspectRunner([], undefined, browsers);
    const result = await inspectSite(home, run, "work", undefined, 1000, noLaunch);
    assert.deepEqual(result, { ok: false, alias: "work", instanceId: edge.instance_id, connection, siteTab: null, identity: "not_verified" });
    assert.deepEqual(calls, [["browsers", "--json"]]);
    assert.ok(!(await readdir(home)).includes("accounts.lock"));
  }
});

test("inspect 无候选标签不发起观察，也不新建", async (t) => {
  const { home } = await fixture(t);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  const { run, calls } = inspectRunner([tab(12, "https://unrelated.test/private")]);
  const result = await inspectSite(home, run, "work", undefined, 1000, noLaunch);
  assert.deepEqual(result, { ok: true, alias: "work", instanceId: edge.instance_id, connection: "online", siteTab: null, identity: "not_verified" });
  assert.equal(calls.length, 2);
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

test("inspect 唯一候选观察身份命中并识别签到信号", async (t) => {
  const { home } = await fixture(t);
  const text = "AgentRouter 控制台\nprivate-identity\n今日已签到\n积分 120\nhttps://agentrouter.org/leaderboard";
  const { run, calls } = inspectRunner([tab(11, "https://agentrouter.org/dashboard")], async (args) => {
    assert.deepEqual(args, ["tab", "observe", "--browser-id", edge.instance_id, "--tab-id", "11", "--expected-origin", "https://agentrouter.org", "--json"]);
    return reply(observed(text));
  });
  const result = await inspectSite(home, run, "work", undefined, 1000, noLaunch);
  assert.equal(result.ok, true);
  assert.equal(result.identity, "matched");
  assert.deepEqual(result.siteTab, { tabId: 11, windowId: 5, active: false });
  assert.equal(result.observation?.documentId, "doc-1");
  assert.deepEqual(result.observation?.signals, { checkedIn: ["已签到", "今日已签到"], checkinAction: [] });
  assert.equal(result.observation?.text, text);
  assert.equal(calls.length, 3);
});

test("inspect 身份未出现报告 absent，并命中待签到动作信号", async (t) => {
  const { home } = await fixture(t);
  const { run } = inspectRunner([tab(11)], async () => reply(observed("欢迎\n每日签到\n其他用户")));
  const result = await inspectSite(home, run, "work", undefined, 1000, noLaunch);
  assert.equal(result.identity, "absent");
  assert.deepEqual(result.observation?.signals, { checkedIn: [], checkinAction: ["每日签到"] });
});

test("inspect 多候选仅唯一 active 自动选择，否则报候选 ID 且不观察", async (t) => {
  const { home } = await fixture(t);
  const single = inspectRunner([tab(11), tab(12, "https://agentrouter.org/", true)]);
  const picked = await inspectSite(home, single.run, "work", undefined, 1000, noLaunch);
  assert.equal(picked.siteTab?.tabId, 12);
  assert.equal(single.calls[2][5], "12");
  const ambiguous = inspectRunner([tab(11), tab(12, "https://agentrouter.org/")]);
  await assert.rejects(inspectSite(home, ambiguous.run, "work", undefined, 1000, noLaunch), { code: "AMBIGUOUS_SITE_TABS" });
  assert.equal(ambiguous.calls.length, 2);
  const explicit = inspectRunner([tab(11), tab(12, "https://agentrouter.org/")]);
  await assert.rejects(inspectSite(home, explicit.run, "work", 99, 1000, noLaunch), { code: "SITE_TAB_NOT_FOUND" });
  assert.equal(explicit.calls.length, 2);
});

test("inspect 观察失败透传 bsk 单行消息，不重试", async (t) => {
  const { home } = await fixture(t);
  const payload = { code: "not_found", message: "No read-only content receiver;\nmanually refresh this page, then retry.", hint: null, exit_code: 1, data: null };
  const { run, calls } = inspectRunner([tab()], async () => ({ stdout: JSON.stringify(payload), exitCode: 1 }));
  await assert.rejects(inspectSite(home, run, "work", undefined, 1000, noLaunch), {
    code: "SITE_INSPECT_FAILED",
    message: /未重试、未刷新页面。bsk：No read-only content receiver; manually refresh this page, then retry\./,
  });
  assert.equal(calls.length, 3);
});

for (const [name, payload] of [
  ["旧组件拒绝", { stdout: "unknown argument", exitCode: 2 }],
  ["非 JSON 错误", { stdout: "boom", exitCode: 1 }],
  ["畸形成功", { stdout: "bad", exitCode: 0 }],
  ["缺字段", reply({ ...observed("x"), text: undefined })],
  ["多余字段", reply({ ...observed("x"), extra: 1 })],
  ["错误实例", reply(observed("x", { browser_id: "other" }))],
  ["错误标签", reply(observed("x", { tab_id: 12 }))],
  ["错误 origin", reply(observed("x", { origin: "https://evil.test" }))],
  ["错误 document", reply(observed("x", { document_id: "bad_id!" }))],
  ["超长正文", reply(observed("x".repeat(8001)))],
  ["错误截断标记", reply(observed("x", { truncated: "no" }))],
] as [string, Result][]) {
  test(`inspect 观察响应${name}拒绝接受`, async (t) => {
    const { home } = await fixture(t);
    const { run, calls } = inspectRunner([tab()], async () => payload);
    await assert.rejects(inspectSite(home, run, "work", undefined, 1000, noLaunch), { code: payload.exitCode ? "SITE_INSPECT_FAILED" : "INVALID_BSK_OUTPUT" });
    assert.equal(calls.length, 3);
    assert.ok(!(await readdir(home)).includes("accounts.lock"));
  });
}

for (const [args, code] of [
  [["accounts", "inspect-site"], "INVALID_ARGUMENT"],
  [["accounts", "inspect-site", "unknown"], "ACCOUNT_NOT_FOUND"],
  [["accounts", "inspect-site", "work", "--confirm"], "INVALID_ARGUMENT"],
  [["accounts", "inspect-site", "work", "--instance-id", "other"], "INVALID_ARGUMENT"],
  [["accounts", "inspect-site", "work", "--tab-id", "0"], "INVALID_TAB_ID"],
  [["accounts", "inspect-site", "work", "--timeout", "6m"], "INVALID_TIMEOUT"],
] as [string[], string][]) {
  test(`CLI 拒绝 ${args.join(" ")}`, async (t) => {
    const { home } = await fixture(t);
    const lines: string[] = [];
    assert.equal(await main([...args, "--json"], { home, run: async () => { assert.fail("非法参数不得调用 bsk"); }, launchDependencies: noLaunch, output: (line) => lines.push(line) }), 1);
    assert.equal(JSON.parse(lines[0]).error.code, code);
  });
}

test("CLI inspect-site 端到端只读输出", async (t) => {
  const { home } = await fixture(t);
  const lines: string[] = [];
  const mock = inspectRunner([tab(11, "https://agentrouter.org/dashboard", true)], async () => reply(observed("private-identity\n已签到")));
  assert.equal(await main(["accounts", "inspect-site", "work", "--json"], { home, run: mock.run, launchDependencies: noLaunch, output: (line) => lines.push(line) }), 0);
  const report = JSON.parse(lines[0]);
  assert.equal(report.ok, true);
  assert.equal(report.identity, "matched");
  assert.deepEqual(report.observation.signals.checkedIn, ["已签到"]);
});
