import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyrouterCheckinAll } from "../src/anyrouter-batch.ts";
import { insertCheckin, insertSnapshot } from "../src/db.ts";
import { readLeftovers } from "../src/leftover.ts";
import type { Browser, Runner } from "../src/core.ts";

const edge6: Browser = {
  instance_id: "a03f225b", browser_name: "Edge", browser_version: "154.0.0.0",
  extension_version: "0.4.0", label: "Edge#a03f", extension_protocol_version: "1.3", version_skew: false,
};
const edgeP16: Browser = {
  instance_id: "21384395", browser_name: "Edge", browser_version: "154.0.0.0",
  extension_version: "0.4.0", label: "Edge#2138", extension_protocol_version: "1.3", version_skew: false,
};

const account6 = {
  alias: "edge-6", instanceId: edge6.instance_id, expectedIdentity: "github_206707",
  boundAt: "2026-09-13T16:54:35.648Z", anyrouterIdentity: "linuxdo_85789",
};
const accountP16 = {
  alias: "edge-p16", instanceId: edgeP16.instance_id, expectedIdentity: "github_20270",
  boundAt: "2026-09-18T07:34:16.143Z", anyrouterIdentity: "linuxdo_85219",
};
// 没绑 AnyRouter 身份的账号：批量必须跳过它
const plainAccount = {
  alias: "edge-1", instanceId: "a82b44ca", expectedIdentity: "github_236536",
  boundAt: "2026-09-13T09:32:45.124Z",
};

function consoleText(identity: string, balance: string): string {
  return `Any Router\n控制台\nL\n${identity}\n👋晚上好，${identity}\n账户数据\n当前余额\n$${balance}\n历史消耗\n$1236.94`;
}

/** 按实例返回对应账号的页面正文，模拟"每个 Profile 登录着不同站点账号"。 */
const pageByInstance: Record<string, string> = {
  [edge6.instance_id]: consoleText("linuxdo_85789", "5121.77"),
  [edgeP16.instance_id]: consoleText("linuxdo_85219", "5037.06"),
};

type ScriptOptions = {
  browsers?: Browser[];
  calls?: string[][];
  /** 让指定实例离线。 */
  offlineInstanceIds?: string[];
  pages?: Record<string, string>;
};

function runner(options: ScriptOptions = {}): Runner {
  // evaluate 不带 --browser-id，只有 session start 带；记下它才能知道
  // 该返回哪个账号的页面正文。
  let currentInstance = "";
  return async (args) => {
    options.calls?.push(args);
    if (args[0] === "browsers" && args[1] === "close") {
      return { stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 };
    }
    if (args[0] === "browsers") {
      const online = (options.browsers ?? [edge6, edgeP16])
        .filter((b) => !(options.offlineInstanceIds ?? []).includes(b.instance_id));
      return { stdout: JSON.stringify(online), exitCode: 0 };
    }
    if (args[0] === "session" && args[1] === "start") {
      const index = args.indexOf("--browser-id");
      currentInstance = index >= 0 ? args[index + 1] : "";
      return { stdout: JSON.stringify({ session_id: "abcd" }), exitCode: 0 };
    }
    if (args[0] === "session" && args[1] === "stop") return { stdout: "", exitCode: 0 };
    if (args[0] === "navigate") return { stdout: "reached=load", exitCode: 0 };
    if (args[0] === "evaluate") {
      return { stdout: JSON.stringify({ ok: true, tab_id: 7, value: (options.pages ?? pageByInstance)[currentInstance] ?? "" }), exitCode: 0 };
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }, accounts: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), "zenx-anyrouter-batch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts }));
  return { home, dbFile: join(home, "checkin.db") };
}

test("批量：依次签到所有绑定了 AnyRouter 身份的账号", async (t) => {
  const { home, dbFile } = await temporary(t, [account6, accountP16, plainAccount]);
  const report = await anyrouterCheckinAll(home, runner(), { dbFile });
  assert.equal(report.total, 2, "只有绑了身份的两个账号");
  assert.equal(report.ok, true);
  assert.deepEqual(report.accounts.map((a) => a.alias).sort(), ["edge-6", "edge-p16"]);
  const p16 = report.accounts.find((a) => a.alias === "edge-p16");
  assert.equal(p16?.identity, "linuxdo_85219");
  assert.equal(p16?.balanceAfter, 5037.06);
});

test("批量：没绑 AnyRouter 身份的账号直接跳过，不报错也不拉起 Edge", async (t) => {
  const { home, dbFile } = await temporary(t, [plainAccount]);
  const calls: string[][] = [];
  const report = await anyrouterCheckinAll(home, runner({ calls }), { dbFile });
  assert.equal(report.total, 0);
  assert.equal(report.ok, true);
  assert.ok(!calls.some((c) => c[0] === "session"));
});

test("批量：单个账号失败不中断后续账号", async (t) => {
  const { home, dbFile } = await temporary(t, [account6, accountP16]);
  // edge-6 离线：批量会先 ensure-online 尝试拉起，而这些测试账号没有 launch 配置，
  // 于是报 LAUNCH_NOT_CONFIGURED（真实环境里配过启动路径就会被拉起）。
  const report = await anyrouterCheckinAll(home, runner({ offlineInstanceIds: [edge6.instance_id] }), { dbFile });
  assert.equal(report.total, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.ok, false);
  const failed = report.accounts.find((a) => !a.ok);
  assert.equal(failed?.alias, "edge-6");
  assert.equal(failed?.code, "LAUNCH_NOT_CONFIGURED");
  // edge-p16 仍然签到成功
  const ok = report.accounts.find((a) => a.ok);
  assert.equal(ok?.alias, "edge-p16");
  assert.equal(ok?.balanceAfter, 5037.06);
});

test("批量：今天已到账的账号连 Edge 都不拉起", async (t) => {
  const { home, dbFile } = await temporary(t, [account6, accountP16]);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  insertCheckin({
    time: new Date(Date.parse(todayStart) + 60_000).toISOString(),
    alias: "edge-6@anyrouter", instanceId: edge6.instance_id, identity: "linuxdo_85789",
    ok: true, balanceBefore: 5096.77, balanceAfter: 5121.77, credited: true, errorCode: null,
  }, dbFile);
  const report = await anyrouterCheckinAll(home, runner(), { dbFile });
  const skipped = report.accounts.find((a) => a.alias === "edge-6");
  assert.equal(skipped?.skipped, "already_credited_today");
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 0);
  // edge-p16 没有被跳过
  assert.equal(report.accounts.find((a) => a.alias === "edge-p16")?.skipped, undefined);
});

test("批量：--force 强制刷新已到账的账号", async (t) => {
  const { home, dbFile } = await temporary(t, [account6]);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  insertCheckin({
    time: new Date(Date.parse(todayStart) + 60_000).toISOString(),
    alias: "edge-6@anyrouter", instanceId: edge6.instance_id, identity: "linuxdo_85789",
    ok: true, balanceBefore: 5096.77, balanceAfter: 5121.77, credited: true, errorCode: null,
  }, dbFile);
  const calls: string[][] = [];
  const report = await anyrouterCheckinAll(home, runner({ calls }), { dbFile, force: true });
  assert.equal(report.skipped, 0);
  assert.equal(report.accounts[0].skipped, undefined);
  assert.ok(calls.some((c) => c[0] === "navigate"), "确实执行了刷新");
});

test("批量：进度回调逐账号报告", async (t) => {
  const { home, dbFile } = await temporary(t, [account6, accountP16]);
  const lines: string[] = [];
  await anyrouterCheckinAll(home, runner(), { dbFile, onProgress: (line) => lines.push(line) });
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.includes("edge-6")));
  assert.ok(lines.some((l) => l.includes("edge-p16")));
});

test("批量：余额下降但加回消耗已到账，输出实际增量", async (t) => {
  const { home, dbFile } = await temporary(t, [account6]);
  const now = new Date();
  insertSnapshot({ time: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString(),
    alias: "edge-6@anyrouter", instanceId: edge6.instance_id, identity: account6.anyrouterIdentity,
    balance: 5114.41, totalSpent: 1269.3, ok: true, errorCode: null }, dbFile);
  const lines: string[] = [];
  const pages = { [edge6.instance_id]: consoleText(account6.anyrouterIdentity, "5042.16").replace("1236.94", "1366.55") };
  const report = await anyrouterCheckinAll(home, runner({ pages }), { dbFile, onProgress: (line) => lines.push(line) });
  assert.equal(report.credited, 1);
  assert.equal(report.accounts[0].creditDelta, 25);
  assert.match(lines[0], /确认到账.*25\.00/);
  assert.doesNotMatch(lines[0], /缺少基线/);
});

test("批量：有基线但没有增量，不再误报缺少基线", async (t) => {
  const { home, dbFile } = await temporary(t, [account6]);
  const now = new Date();
  insertCheckin({ time: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString(),
    alias: "edge-6@anyrouter", instanceId: edge6.instance_id, identity: account6.anyrouterIdentity,
    balanceBefore: null, balanceAfter: 5121.77, ok: true, credited: false, errorCode: null }, dbFile);
  const lines: string[] = [];
  const report = await anyrouterCheckinAll(home, runner(), { dbFile, onProgress: (line) => lines.push(line) });
  assert.equal(report.accounts[0].credited, false);
  assert.match(lines[0], /无法确认到账/);
  assert.match(lines[0], /缺少可用的配对消耗/);
  assert.doesNotMatch(lines[0], /缺少基线/);
});

test("批量：没有绑定任何 AnyRouter 身份时给出提示而非报错", async (t) => {
  const { home, dbFile } = await temporary(t, [plainAccount]);
  const lines: string[] = [];
  const report = await anyrouterCheckinAll(home, runner(), { dbFile, onProgress: (l) => lines.push(l) });
  assert.equal(report.total, 0);
  assert.ok(lines.some((l) => l.includes("bind-anyrouter")));
});

// checkin-all 会把 --close-after 传下来：AnyRouter 那两个号也不能留着占内存。
// 但这些账号本来就在线（= 用户自己的 Edge），一个都不该关。
test("批量：--close-after 不关闭本来就在跑的 Edge", async (t) => {
  const { home, dbFile } = await temporary(t, [account6, accountP16]);
  const calls: string[][] = [];
  const report = await anyrouterCheckinAll(home, runner({ calls }), { dbFile, closeAfter: true });
  assert.equal(report.released, 0);
  assert.ok(!calls.some((c) => c[0] === "browsers" && c[1] === "close"), "没有本轮拉起的实例可关");
  assert.equal(report.accounts.every((a) => a.closed === false), true);
});

// 本轮拉起的实例必须关掉，且关闭后遗留追踪要清除（否则事后会被当成"用户自己的 Edge"）。
// 给自己开着的那个（edge-p16）保留——关掉它会连标签页和未保存内容一起带走。
test("批量：--close-after 关掉自己拉起的实例，别人的保留", async (t) => {
  const { home, dbFile } = await temporary(t, [account6, accountP16]);
  const userDataDir = join(home, "User Data");
  const profile = join(userDataDir, "Profile-6");
  await mkdir(profile, { recursive: true });
  const edgePath = join(home, "msedge.exe");
  await writeFile(edgePath, "fake");
  await writeFile(join(profile, "Preferences"), "{}");
  await writeFile(join(home, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [
      { ...account6, launch: { edgePath, userDataDir, profileDirectory: "Profile-6" } },
      accountP16,
    ],
  }));
  // edge-6 靠 injected launch 拉起；edge-p16 一直在线（= 用户自己的 Edge）。
  const state = { launched: false, currentInstance: "" };
  const spy: Runner = (args) => {
    if (args[0] === "browsers" && args[1] === "close") {
      state.launched = false;   // 关掉后复核要能看到它离线
      return Promise.resolve({ stdout: JSON.stringify({ browser_id: args[3], closed: true, windows_closed: 1, sessions_stopped: 0, disconnected: true }), exitCode: 0 });
    }
    if (args[0] === "browsers") {
      const list = [edgeP16];
      if (state.launched) list.unshift(edge6);
      return Promise.resolve({ stdout: JSON.stringify(list), exitCode: 0 });
    }
    if (args[0] === "session" && args[1] === "start") {
      const index = args.indexOf("--browser-id");
      state.currentInstance = index >= 0 ? args[index + 1] : "";
      return Promise.resolve({ stdout: JSON.stringify({ session_id: "abcd" }), exitCode: 0 });
    }
    if (args[0] === "session" && args[1] === "stop") return Promise.resolve({ stdout: "", exitCode: 0 });
    if (args[0] === "navigate") return Promise.resolve({ stdout: "reached=load", exitCode: 0 });
    if (args[0] === "evaluate") {
      return Promise.resolve({ stdout: JSON.stringify({ ok: true, tab_id: 7, value: pageByInstance[state.currentInstance] ?? "" }), exitCode: 0 });
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
  const lines: string[] = [];
  const report = await anyrouterCheckinAll(home, spy, {
    dbFile,
    closeAfter: true,
    launchDependencies: { launch: async () => { state.launched = true; }, platform: "win32", sleep: async () => {} },
    onProgress: (l) => lines.push(l),
  });
  assert.equal(report.released, 1, "只关 edge-6（本轮拉起的那个）");
  const closed = report.accounts.find((a) => a.alias === "edge-6");
  assert.equal(closed?.launched, true);
  assert.equal(closed?.closed, true);
  assert.equal(report.accounts.find((a) => a.alias === "edge-p16")?.closed, false, "用户自己的 Edge 保留");
  assert.ok(lines.some((l) => l.includes("非本轮拉起")), "保留要明确说清原因");
  // 关闭确认后不该再留下遗留记录
  assert.deepEqual((await readLeftovers(home)).instances, []);
});
