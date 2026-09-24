import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLaunchedInstance, leftoverFileFor, markLeftoverCloseError, readLeftovers, recordLaunchedInstance } from "../src/leftover.ts";
import { closeAllBrowsers, closeLeftoverInstances } from "../src/launch.ts";
import type { Account, Browser, Runner } from "../src/core.ts";

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
  { alias: "gamma", instanceId: "gggg3333", expectedIdentity: "github_3", boundAt: "2026-09-13T00:00:00Z" },
];

async function fixture(t: { after: (fn: () => Promise<void>) => void }, store: Account[] = accounts) {
  const home = await mkdtemp(join(tmpdir(), "zenx-leftover-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: store }));
  return home;
}

/** 假 bsk：online 里的实例可列出可关闭；unsupported 里的实例不认识 browser.close。 */
function fakeBsk(state: { online: Set<string>; unsupported?: Set<string> }) {
  const closeCalls: string[] = [];
  const run: Runner = (args) => {
    if (args[0] === "browsers" && args[1] === "close") {
      const id = args[3];
      closeCalls.push(id);
      if (state.unsupported?.has(id)) return Promise.resolve({ stdout: '{"error":"unknown_method: browser.close"}', exitCode: 1 });
      state.online.delete(id);
      return Promise.resolve({
        stdout: JSON.stringify({ browser_id: id, closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }),
        exitCode: 0,
      });
    }
    if (args[0] === "browsers") return Promise.resolve({ stdout: JSON.stringify([...state.online].map(browser)), exitCode: 0 });
    return Promise.reject(new Error(`意外调用：${args.join(" ")}`));
  };
  return { run, closeCalls };
}

test("记录拉起、按实例 ID 清除、失败原因回写", async (t) => {
  const home = await fixture(t);
  await recordLaunchedInstance(home, "alpha", "aaaa1111");
  await recordLaunchedInstance(home, "beta", "bbbb2222");
  let state = await readLeftovers(home);
  assert.deepEqual(state.instances.map((item) => item.alias).sort(), ["alpha", "beta"]);

  // 同一别名重复拉起覆盖旧记录（含清除旧的失败原因）。
  await markLeftoverCloseError(home, "alpha", "aaaa1111", "CLOSE_NOT_SUPPORTED: 旧扩展");
  await recordLaunchedInstance(home, "alpha", "aaaa9999");
  state = await readLeftovers(home);
  assert.equal(state.instances.length, 2);
  const alpha = state.instances.find((item) => item.alias === "alpha");
  assert.equal(alpha?.instanceId, "aaaa9999");
  assert.equal(alpha?.lastCloseError, undefined);

  // 给 instanceId 时只清匹配的那条，误删新记录是事故。
  await recordLaunchedInstance(home, "alpha", "aaaa1111");
  await clearLaunchedInstance(home, "alpha", "aaaa9999");
  state = await readLeftovers(home);
  assert.equal(state.instances.some((item) => item.alias === "alpha" && item.instanceId === "aaaa1111"), true);

  await clearLaunchedInstance(home, "alpha");
  state = await readLeftovers(home);
  assert.deepEqual(state.instances.map((item) => item.alias), ["beta"]);
});

test("追踪文件损坏或缺失时当作没有遗留", async (t) => {
  const home = await fixture(t);
  assert.deepEqual((await readLeftovers(home)).instances, []);
  await writeFile(leftoverFileFor(home), "not-json");
  assert.deepEqual((await readLeftovers(home)).instances, []);
  await writeFile(leftoverFileFor(home), JSON.stringify({ version: 1, instances: [{ alias: 1 }, { alias: "beta", instanceId: "bbbb2222", launchedAt: "2026-09-24T00:00:00Z" }] }));
  assert.deepEqual((await readLeftovers(home)).instances.map((item) => item.alias), ["beta"], "畸形条目被丢弃，合法条目保留");
});

test("close-all：在线的关闭、离线的跳过、旧扩展失败不中断并汇总", async (t) => {
  const home = await fixture(t);
  const { run, closeCalls } = fakeBsk({ online: new Set(["aaaa1111", "gggg3333"]), unsupported: new Set(["gggg3333"]) });
  const lines: string[] = [];
  const report = await closeAllBrowsers(home, run, 45_000, {}, (line) => lines.push(line));
  assert.equal(report.ok, false, "有失败就不能报 ok");
  assert.equal(report.total, 3);
  assert.equal(report.closed, 1);
  assert.equal(report.offline, 1);
  assert.equal(report.failed, 1);
  const byAlias = new Map(report.accounts.map((item) => [item.alias, item]));
  assert.equal(byAlias.get("alpha")?.status, "closed");
  assert.equal(byAlias.get("beta")?.status, "offline");
  assert.equal(byAlias.get("gamma")?.code, "CLOSE_NOT_SUPPORTED");
  assert.deepEqual(closeCalls, ["aaaa1111", "gggg3333"], "失败的账号不挡住后面的账号");
  assert.equal(lines.length, 3, "每个账号都有一行进度");
});

test("close-all：离线账号顺带清掉它的遗留追踪", async (t) => {
  const home = await fixture(t);
  await recordLaunchedInstance(home, "beta", "bbbb2222");
  const { run } = fakeBsk({ online: new Set() });
  const report = await closeAllBrowsers(home, run);
  assert.equal(report.offline, 3);
  assert.deepEqual((await readLeftovers(home)).instances, [], "离线即无可关，记录应清除");
});

test("close-leftover：在线遗留关闭并移除记录，离线遗留直接移除记录", async (t) => {
  const home = await fixture(t);
  await recordLaunchedInstance(home, "alpha", "aaaa1111");
  await recordLaunchedInstance(home, "beta", "bbbb2222");
  const { run, closeCalls } = fakeBsk({ online: new Set(["aaaa1111"]) });
  const report = await closeLeftoverInstances(home, run);
  assert.equal(report.ok, true);
  assert.equal(report.tracked, 2);
  assert.equal(report.closed, 1);
  assert.equal(report.dropped, 1);
  assert.deepEqual(closeCalls, ["aaaa1111"]);
  assert.deepEqual((await readLeftovers(home)).instances, [], "两条记录都应有归宿");
});

test("close-leftover：实例 ID 改绑给其他账号时绝不动它，只移除记录", async (t) => {
  const home = await fixture(t);
  // gamma 的记录指向 beta 现在绑定的实例：这个窗口已经名花有主。
  await recordLaunchedInstance(home, "gamma", "bbbb2222");
  const { run, closeCalls } = fakeBsk({ online: new Set(["bbbb2222"]) });
  const report = await closeLeftoverInstances(home, run);
  assert.equal(report.instances[0]?.status, "rebound");
  assert.deepEqual(closeCalls, [], "改绑的实例绝不能关");
  assert.deepEqual((await readLeftovers(home)).instances, []);
});

test("close-leftover：旧扩展关不掉时保留记录并写明原因，下次再试", async (t) => {
  const home = await fixture(t);
  await recordLaunchedInstance(home, "gamma", "gggg3333");
  const { run } = fakeBsk({ online: new Set(["gggg3333"]), unsupported: new Set(["gggg3333"]) });
  const report = await closeLeftoverInstances(home, run);
  assert.equal(report.ok, false);
  assert.equal(report.failed, 1);
  assert.equal(report.instances[0]?.code, "CLOSE_NOT_SUPPORTED");
  const state = await readLeftovers(home);
  assert.equal(state.instances.length, 1, "失败的记录要留下，下次 close-leftover 再试");
  assert.match(state.instances[0]?.lastCloseError ?? "", /CLOSE_NOT_SUPPORTED/);
});
