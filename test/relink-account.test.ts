import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStore } from "../src/core.ts";
import type { Browser, Runner } from "../src/core.ts";
import { configureLaunch, relinkAccount } from "../src/launch.ts";
import type { LaunchConfig } from "../src/launch.ts";

const ANCHOR = "349ef2e021faa0fa";

const online: Browser = {
  instance_id: "aaaa1111", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "日更", extension_protocol_version: "1.3", version_skew: false,
};
const stale: Browser = { ...online, instance_id: "bbbb2222", label: "备用" };
const other: Browser = { ...online, instance_id: "cccc3333", label: "另一个" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-relink-account-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config: LaunchConfig = {
    edgePath: join(home, "msedge.exe"),
    userDataDir: join(home, "User Data"),
    profileDirectory: "Profile 3",
  };
  await mkdir(join(config.userDataDir, config.profileDirectory), { recursive: true });
  await writeFile(config.edgePath, "模拟可执行文件，不可启动");
  await writeFile(join(config.userDataDir, config.profileDirectory, "Preferences"), JSON.stringify({
    account_info: { account_id: ANCHOR, email: "ignored@example.com" },
    profile: { name: "916938 13" },
  }));
  await writeFile(join(home, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [{
      alias: "work", instanceId: stale.instance_id, expectedIdentity: "user-1",
      boundAt: "2026-09-13T00:00:00.000Z",
    }],
  }));
  return { home, config };
}

/** 记录探测窗口是否都被回收。 */
function runner(browsers: Browser[]) {
  const stops: string[][] = [];
  const run: Runner = async (args) => {
    if (args[0] === "browsers") return { stdout: JSON.stringify(browsers), exitCode: 0 };
    if (args[0] === "session" && args[1] === "start") return { stdout: JSON.stringify({ session_id: "wxyz" }), exitCode: 0 };
    if (args[0] === "session" && args[1] === "stop") { stops.push(args); return { stdout: "stopped", exitCode: 0 }; }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  return { run, stops };
}

test("configure-launch 记录账号锚点（不写入私密字段）", async (t) => {
  const { home, config } = await fixture(t);
  const saved = await configureLaunch(home, "work", config, true);
  assert.equal(saved.profileAccountId, ANCHOR);
  assert.equal(saved.profileAccountSource, "preferences");
  const raw = await readFile(join(home, "accounts.json"), "utf8");
  assert.equal(raw.includes("ignored@example.com"), false);
});

test("configure-launch 读不到锚点时不写入空值", async (t) => {
  const { home, config } = await fixture(t);
  await writeFile(join(config.userDataDir, config.profileDirectory, "Preferences"), "{}");
  const saved = await configureLaunch(home, "work", config, true);
  assert.equal(saved.profileAccountId, undefined);
  assert.equal(saved.profileAccountSource, undefined);
});

test("bsk 直报账号 ID 时零探测改绑，不开任何窗口", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const { run, stops } = runner([{ ...online, profile_account_id: ANCHOR }, other]);
  const result = await relinkAccount(home, run, "work", 30_000, { now: () => 0, sleep: async () => {} });
  assert.deepEqual(result, {
    ok: true, alias: "work", profileDirectory: "Profile 3", profileAccountId: ANCHOR,
    previousInstanceId: stale.instance_id, instanceId: online.instance_id, changed: true, method: "bsk",
  });
  assert.deepEqual(stops, [], "直报命中不该开探测窗口");
  assert.equal((await readStore(home)).accounts[0].instanceId, online.instance_id);
});

test("bsk 直报命中多个 → PROFILE_AMBIGUOUS，不改绑", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const { run } = runner([
    { ...online, profile_account_id: ANCHOR },
    { ...other, profile_account_id: ANCHOR },
  ]);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  await assert.rejects(relinkAccount(home, run, "work", 30_000, { now: () => 0, sleep: async () => {} }), { code: "PROFILE_AMBIGUOUS" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

test("bsk 无该字段时回退标题+Preferences 定位并改绑", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const { run, stops } = runner([online]);
  const result = await relinkAccount(home, run, "work", 30_000, {
    now: () => 0,
    sleep: async () => {},
    listWindowTitles: async () => [`about:blank - 916938 13 - Microsoft Edge`],
    detectProfile: async (_before, expected) => (expected === "Profile 3" ? "916938 13" : null),
  });
  assert.equal(result.method, "preferences");
  assert.equal(result.instanceId, online.instance_id);
  assert.deepEqual(stops, [["session", "stop", "wxyz"]], "探测窗口必须回收");
});

test("回退路径命中多个 → PROFILE_AMBIGUOUS，不改绑", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const { run } = runner([online, other]);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  await assert.rejects(relinkAccount(home, run, "work", 30_000, {
    now: () => 0,
    sleep: async () => {},
    listWindowTitles: async () => [`about:blank - 916938 13 - Microsoft Edge`],
    detectProfile: async () => "916938 13",
  }), { code: "PROFILE_AMBIGUOUS" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

test("回退路径无实例匹配 → PROFILE_NOT_FOUND，不改绑", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const { run } = runner([online]);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  await assert.rejects(relinkAccount(home, run, "work", 30_000, {
    now: () => 0,
    sleep: async () => {},
    listWindowTitles: async () => [],
    detectProfile: async () => null,
  }), { code: "PROFILE_NOT_FOUND" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

test("实例 ID 未变时报告 changed:false", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const { run } = runner([{ ...stale, profile_account_id: ANCHOR }]);
  const result = await relinkAccount(home, run, "work", 30_000, { now: () => 0, sleep: async () => {} });
  assert.equal(result.changed, false);
  assert.equal(result.instanceId, stale.instance_id);
});

test("未配置启动路径 → LAUNCH_NOT_CONFIGURED", async (t) => {
  const { home } = await fixture(t);
  await assert.rejects(relinkAccount(home, online as unknown as Runner, "work", 30_000), { code: "LAUNCH_NOT_CONFIGURED" });
});

test("读不到账号锚点 → ACCOUNT_ANCHOR_MISSING，不改绑", async (t) => {
  const { home, config } = await fixture(t);
  // 未记录锚点，且 Preferences 也读不到（模拟未登录 Profile）。
  await writeFile(join(config.userDataDir, config.profileDirectory, "Preferences"), "{}");
  await configureLaunch(home, "work", config, true);
  assert.equal((await readStore(home)).accounts[0].profileAccountId, undefined);
  const { run } = runner([online]);
  const before = await readFile(join(home, "accounts.json"), "utf8");
  await assert.rejects(relinkAccount(home, run, "work", 30_000, {
    now: () => 0,
    sleep: async () => {},
    readProfileAccount: async () => ({ accountId: "", profileName: "" }),
  }), { code: "ACCOUNT_ANCHOR_MISSING" });
  assert.equal(await readFile(join(home, "accounts.json"), "utf8"), before);
});

test("Profile 当前读不到时回退已记录的锚点", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  // Preferences 被清理（Edge 运行中可能无法读到），但配置里已记录锚点。
  await writeFile(join(config.userDataDir, config.profileDirectory, "Preferences"), "{}");
  const { run } = runner([{ ...online, profile_account_id: ANCHOR }]);
  const result = await relinkAccount(home, run, "work", 30_000, { now: () => 0, sleep: async () => {} });
  assert.equal(result.method, "bsk");
  assert.equal(result.instanceId, online.instance_id);
});

test("无在线 Edge → NO_EDGE_CONNECTED", async (t) => {
  const { home, config } = await fixture(t);
  await configureLaunch(home, "work", config, true);
  const run: Runner = async () => ({ stdout: "[]", exitCode: 0 });
  await assert.rejects(relinkAccount(home, run, "work", 30_000, { now: () => 0 }), { code: "NO_EDGE_CONNECTED" });
});
