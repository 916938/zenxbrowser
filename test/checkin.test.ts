import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkinAccount } from "../src/checkin.ts";
import { main } from "../src/cli.ts";
import type { Account, Browser, Runner, Result } from "../src/core.ts";
import type { CheckinDependencies } from "../src/checkin.ts";

const edge: Browser = {
  instance_id: "exact-instance", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "Edge#exac", extension_protocol_version: "1.3", version_skew: false,
};
const account: Account = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "github_16350", boundAt: "2026-09-13T00:00:00Z" };
const reply = (value: unknown): Result => ({ stdout: typeof value === "string" ? value : JSON.stringify(value), exitCode: 0 });

const observeWithAnnouncement = [
  'L1 modal cover=100%',
  '  dialog "系统公告 通知 系统公告"',
  '    @e4 button "今日关闭"',
  '    @e5 button "关闭公告"',
  'L2 page … occluded by L1',
].join("\n");
const observeLoggedIn = [
  'L1 page',
  '  RootWebArea "Agent Router"',
  '    @e11 button "G github_16350 chevron_down [has-submenu]"',
  '    main "👋晚上好，github_16350 账户数据 当前余额 $555.18 历史消耗 $3104.82"',
].join("\n");
const observeMenuOpen = [
  'L1 page',
  '    @e11 button "G github_16350 chevron_down [expanded]"',
  '    @e110 menuitem "exit 退出"',
].join("\n");
const observeLoggedOut = [
  'L1 page',
  '    @e12 button "github_logo 使用 GitHub 继续"',
  '    alert "success type"',
  '      StaticText "注销成功!"',
].join("\n");
const observeDashboard = (balance: string) => [
  'L1 page',
  '    @e11 button "G github_16350 chevron_down [has-submenu]"',
  `    @e22 button "当前余额 ${balance}"`,
  '    alert "success type"',
  '      StaticText "签到成功，新增额度已到账"',
].join("\n");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-checkin-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [account] }));
  return home;
}

const clock = (): { now: () => number; sleeps: number[] } => {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; sleeps.push(ms); },
  };
};

type Script = { navigate?: Result; observes?: Result[]; clicks?: Record<string, Result>; hovers?: Record<string, Result> };

function scriptRunner(script: Script, browsers: Browser[] = [edge]) {
  const calls: string[][] = [];
  let observeIndex = 0;
  const run: Runner = async (args, options) => {
    calls.push(args);
    assert.equal(options?.env?.BSK_BROWSER_WAIT_MS, "0");
    if (args[0] === "browsers") { assert.deepEqual(args, ["browsers", "--json"]); return reply(browsers); }
    if (args[0] === "session" && args[1] === "start") return reply({ session_id: "abcd", agent_window_id: 1 });
    if (args[0] === "session" && args[1] === "stop") return reply({ stopped: "abcd" });
    if (args[0] === "navigate") return script.navigate ?? reply("tab=1 reached=load");
    if (args[0] === "observe") {
      const observes = script.observes ?? [];
      const result = observes[Math.min(observeIndex, observes.length - 1)];
      observeIndex += 1;
      return result ?? reply("L1 page");
    }
    if (args[0] === "click") {
      const ref = args[1];
      return script.clicks?.[ref] ?? reply(`click ok target=${ref}`);
    }
    if (args[0] === "hover") {
      const ref = args[1];
      return script.hovers?.[ref] ?? reply(`hover ok target=${ref}`);
    }
    throw new Error(`unexpected bsk call: ${args.join(" ")}`);
  };
  return { run, calls };
}

const deps = (): CheckinDependencies => { const c = clock(); return { now: c.now, sleep: c.sleep }; };

test("checkin 快乐路径：公告关闭→身份验证→退出→重登→签到到账", async (t) => {
  const home = await fixture(t);
  const { run, calls } = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),   // ② 首次 observe：有公告
      reply(observeLoggedIn),           // ③ 关闭后 observe：无公告，身份+余额
      reply(observeMenuOpen),           // ⑥ hover 后 observe：菜单展开
      reply(observeLoggedOut),          // ⑥ 点击退出后 observe：登录页
      reply(observeDashboard("$580.18")), // ⑦ 轮询首次：已登录+签到成功
    ],
  });
  const report = await checkinAccount(home, run, "work", 180_000, deps());
  assert.equal(report.ok, true);
  assert.equal(report.identity, "github_16350");
  assert.equal(report.balanceBefore, 555.18);
  assert.equal(report.balanceAfter, 580.18);
  assert.equal(report.checkinCredited, true);
  // session start 带隔离参数
  assert.deepEqual(calls[1], ["session", "start", "--browser-id", edge.instance_id, "--no-focus", "--json"]);
  // finally 中必定 stop
  assert.equal(calls[calls.length - 1][0], "session");
  assert.equal(calls[calls.length - 1][1], "stop");
  // 退出前身份验证失败前不应有点击 GitHub
  const githubClick = calls.find((args) => args[0] === "click" && args[1] === "@e12");
  assert.ok(githubClick, "应点击 GitHub 登录按钮");
});

test("checkin 公告两次点击仍失败 → ANNOUNCEMENT_CLOSE_FAILED 且 stop 仍执行", async (t) => {
  const home = await fixture(t);
  const { run, calls } = scriptRunner({
    observes: [reply(observeWithAnnouncement), reply(observeWithAnnouncement), reply(observeWithAnnouncement)],
  });
  await assert.rejects(checkinAccount(home, run, "work", 180_000, deps()), { code: "ANNOUNCEMENT_CLOSE_FAILED" });
  assert.equal(calls[calls.length - 1][1], "stop");
});

test("checkin 身份不匹配 → IDENTITY_MISMATCH 且无后续点击", async (t) => {
  const home = await fixture(t);
  const wrongIdentity = observeLoggedIn.replace(/github_16350/g, "github_other");
  const { run, calls } = scriptRunner({ observes: [reply(wrongIdentity)] });
  await assert.rejects(checkinAccount(home, run, "work", 180_000, deps()), { code: "IDENTITY_MISMATCH" });
  assert.equal(calls.filter((args) => args[0] === "click").length, 0, "身份不匹配不得点击");
  assert.equal(calls[calls.length - 1][1], "stop");
});

test("checkin 轮询遇 GitHub 授权页 → MANUAL_INTERVENTION_REQUIRED", async (t) => {
  const home = await fixture(t);
  const { run, calls } = scriptRunner({
    observes: [
      reply(observeLoggedIn),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply("L1 page\n  heading \"Sign in to GitHub\"\n  @e1 button \"Sign in\""),
    ],
  });
  await assert.rejects(checkinAccount(home, run, "work", 180_000, deps()), { code: "MANUAL_INTERVENTION_REQUIRED" });
  assert.equal(calls[calls.length - 1][1], "stop");
});

test("checkin 轮询超时 → LOGIN_TIMEOUT", async (t) => {
  const home = await fixture(t);
  const { run, calls } = scriptRunner({
    observes: [
      reply(observeLoggedIn),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      ...Array.from({ length: 40 }, () => reply("L1 page\n  StaticText \"跳转中...\"")),
    ],
  });
  await assert.rejects(checkinAccount(home, run, "work", 180_000, deps()), { code: "LOGIN_TIMEOUT" });
  assert.equal(calls[calls.length - 1][1], "stop");
});

test("checkin 余额未变且无签到提示 → CHECKIN_UNCONFIRMED", async (t) => {
  const home = await fixture(t);
  const noSignal = observeDashboard("$555.18").replace(/签到成功，新增额度已到账/, "无新增");
  const { run, calls } = scriptRunner({
    observes: [
      reply(observeLoggedIn),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(noSignal),
    ],
  });
  const report = await checkinAccount(home, run, "work", 180_000, deps());
  assert.equal(report.ok, false);
  assert.equal(report.balanceBefore, 555.18);
  assert.equal(report.balanceAfter, 555.18);
  assert.equal(report.checkinCredited, false);
  assert.equal(calls[calls.length - 1][1], "stop");
});

test("checkin 离线直接报告，不启动 session", async (t) => {
  const home = await fixture(t);
  const { run, calls } = scriptRunner({}, []);
  const report = await checkinAccount(home, run, "work", 180_000, deps());
  assert.equal(report.ok, false);
  assert.equal((report as { connection: string }).connection, "offline");
  assert.ok(!calls.some((args) => args[0] === "session"), "离线不得启动 session");
});

test("checkin session start 失败 → SESSION_START_FAILED", async (t) => {
  const home = await fixture(t);
  const run: Runner = async (args) => {
    if (args[0] === "browsers") return reply([edge]);
    if (args[0] === "session" && args[1] === "start") return { stdout: "error: not found", exitCode: 1 };
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(checkinAccount(home, run, "work", 180_000, deps()), { code: "SESSION_START_FAILED" });
});

test("CLI checkin 参数校验：缺别名、非法 timeout、多余选项", async (t) => {
  const home = await fixture(t);
  const cases: [string[], string][] = [
    [["accounts", "checkin"], "ACCOUNT_NOT_FOUND|INVALID_ARGUMENT"],
    [["accounts", "checkin", "work", "--timeout", "6m"], "INVALID_TIMEOUT"],
    [["accounts", "checkin", "work", "--tab-id", "11"], "INVALID_ARGUMENT"],
  ];
  for (const [args, code] of cases) {
    const lines: string[] = [];
    const exit = await main([...args, "--json", "--home", home], { output: (line) => lines.push(line) });
    assert.equal(exit, 1);
    assert.match(JSON.parse(lines[0]).error.code, new RegExp(code));
  }
});

test("CLI checkin --help 提到新命令", async () => {
  const lines: string[] = [];
  await main(["--help"], { output: (line) => lines.push(line) });
  const help = lines.join("\n");
  assert.match(help, /accounts checkin <别名>/);
  assert.match(help, /checkin 执行完整退出重登签到流程/);
  assert.doesNotMatch(help, /不执行签到。$/);
});
