import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { checkinAccount, labelOfRef } from "../src/checkin.ts";
import { DEFAULT_DB_FILE, insertCheckin, listCheckins } from "../src/db.ts";
import { main } from "../src/cli.ts";
import type { Account, Browser, Runner, RunnerOptions, Result } from "../src/core.ts";
import type { CheckinDependencies } from "../src/checkin.ts";

const edge: Browser = {
  instance_id: "exact-instance", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "Edge#exac", extension_protocol_version: "1.3", version_skew: false,
};
const account: Account = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "github_16350", boundAt: "2026-09-13T00:00:00Z" };
const reply = (value: unknown): Result => ({ stdout: typeof value === "string" ? value : JSON.stringify(value), exitCode: 0 });
const settle = (finished = 0, events = 0): Result => reply({ ok: true, value: { finished, events } });
/** 真实 bsk observe 人读输出以 @vom 头开始（含 @view/@layers 行，此处从简）。 */
const vom = (text: string): string => `@vom 1\n${text}`;

const observeWithAnnouncement = vom([
  'L1 modal cover=100%',
  '  dialog "系统公告 通知 系统公告"',
  '  StaticText "Using Chat with tools will trigger an error: “Function tools are not supported”."',
  '    @e4 button "今日关闭"',
  '    @e5 button "关闭公告"',
  'L2 page … occluded by L1',
].join("\n"));
/** 控制台仪表盘（已登录）：用户菜单 + 当前余额。 */
const observeConsole = vom([
  'L1 page',
  '  RootWebArea "Agent Router"',
  '    @e11 button "G github_16350 chevron_down [has-submenu]"',
  '    main "👋晚上好，github_16350 账户数据 当前余额 $555.18 历史消耗 $3104.82"',
].join("\n"));
const observeMenuOpen = vom([
  'L1 page',
  '    @e11 button "G github_16350 chevron_down [expanded]"',
  '    @e110 menuitem "exit 退出"',
].join("\n"));
// 界面语言因账号而异：同一套流程在英文界面下的文案完全不同（公告 System Notice /
// 退出项 exit Quit / 登录按钮 Continue with GitHub / 余额 Current balance）。
// 只认中文会让这些账号卡在 IDENTITY_MISMATCH、LOGOUT_FAILED、LOGIN_TIMEOUT。
const observeAnnouncementEn = vom([
  'L1 modal cover=100%',
  '  dialog "System Notice Notice System Notice"',
  '    @e4 button "Close Today"',
  '    @e5 button "Close Notice"',
  'L2 page … occluded by L1',
].join("\n"));
const observeConsoleEn = vom([
  'L1 page',
  '  RootWebArea "Agent Router"',
  '    @e11 button "G github_16350 chevron_down [has-submenu]"',
  '    main "Account Data Current balance $555.18 Consumption $3104.82"',
].join("\n"));
const observeMenuOpenEn = vom([
  'L1 page',
  '    @e11 button "G github_16350 chevron_down [expanded]"',
  '    @e110 menuitem "exit Quit"',
].join("\n"));
const observeLoggedOutEn = vom([
  'L1 page',
  '    @e12 button "github_logo Continue with GitHub"',
  '    StaticText "Logged out successfully"',
].join("\n"));
const observeDashboardEn = vom([
  'L1 page',
  '    @e11 button "G github_16350 chevron_down [has-submenu]"',
  '    @e22 button "Current balance $580.18"',
].join("\n"));
const observeLoggedOut = vom([
  'L1 page',
  '    @e12 button "github_logo 使用 GitHub 继续"',
  '    alert "success type"',
  '      StaticText "注销成功!"',
].join("\n"));
/** OAuth 落地页（首页）：已登录（菜单在场）但无余额文本。 */
const observeLanding = vom([
  'L1 page',
  '  RootWebArea "Agent Router"',
  '    @e11 button "G github_16350 chevron_down [has-submenu]"',
  '    main "统一的 大模型接口网关"',
].join("\n"));
const observeDashboard = (balance: string, toast = true) => vom([
  'L1 page',
  '    @e11 button "G github_16350 chevron_down [has-submenu]"',
  `    @e22 button "当前余额 ${balance}"`,
  '    alert "success type"',
  `      StaticText "${toast ? "签到成功，新增额度已到账" : "无新增"}"`,
].join("\n"));

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-checkin-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [account] }));
  return home;
}

// 测试一律写临时数据库，绝不污染项目根 zenxbrowser/checkin.db（真实签到账本）。
const clock = (): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[]; dbFile: string } => {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; sleeps.push(ms); },
    sleeps,
    dbFile: join(tmpdir(), `zenx-checkin-db-${randomUUID()}.db`),
  };
};

/** DOM 直调表达式里使用的 PointerEvent 替身（测试在 vm 中运行，没有真实 DOM 全局）。 */
class FakePointerEvent {
  type: string;
  constructor(type: string) { this.type = type; }
}

/** 从 bsk 调用里区分各类页面内求值：窗口探测 / DOM 直调 / OAuth 捕获与跳转 / 动画收敛。 */
const isWindowProbe = (expression: string) => expression.includes("zenx-dom-interact:probe");
const isDomInteract = (expression: string) => /zenx-dom-interact:(click|hover)/.test(expression);
const isOAuthCapture = (expression: string) => expression.includes("zenx-oauth-capture:capture");
const isOAuthRead = (expression: string) => expression.includes("zenx-oauth-capture:read");

type Script = {
  navigate?: Result;
  /** 按调用次序返回 navigate 结果；用尽后回退到 navigate。 */
  navigates?: Result[];
  observes?: Result[];
  settle?: Result[];
  window?: Result;
  clicks?: Record<string, Result>;
  hovers?: Record<string, Result>;
  domInteracts?: Result[];
  oauthCapture?: Result;
  oauthRead?: Result;
  oauthNavigate?: Result;
};

function scriptRunner(script: Script, browsers: Browser[] = [edge]) {
  const calls: string[][] = [];
  const stops: (RunnerOptions | undefined)[] = [];
  let observeIndex = 0;
  let settleIndex = 0;
  let domIndex = 0;
  let navigateIndex = 0;
  const run: Runner = async (args, options) => {
    calls.push(args);
    if (args[0] === "session" && args[1] === "stop") {
      stops.push(options);
      return reply({ stopped: "abcd" });
    }
    assert.equal(options?.env?.BSK_BROWSER_WAIT_MS, "0");
    if (args[0] === "browsers") { assert.deepEqual(args, ["browsers", "--json"]); return reply(browsers); }
    if (args[0] === "session" && args[1] === "start") {
      assert.deepEqual(args, ["session", "start", "--browser-id", edge.instance_id, "--width", "1280", "--height", "800", "--json"]);
      return reply({ session_id: "abcd", agent_window_id: 1 });
    }
    if (args[0] === "navigate") {
      assert.deepEqual(args, ["navigate", "https://agentrouter.org/console", "--session", "abcd"]);
      const attempts = script.navigates ?? [];
      const result = attempts[Math.min(navigateIndex, attempts.length - 1)];
      navigateIndex += 1;
      return result ?? script.navigate ?? reply("tab=1 reached=load");
    }
    if (args[0] === "evaluate") {
      assert.equal(typeof args[1], "string");
      assert.ok(args[1].length > 0);
      assert.deepEqual(args.slice(2), ["--json", "--session", "abcd"]);
      if (isWindowProbe(args[1])) {
        return script.window ?? reply({ ok: true, value: { visible: true, w: 1280, h: 800 } });
      }
      if (isDomInteract(args[1])) {
        const inter = script.domInteracts ?? [];
        const result = inter[Math.min(domIndex, inter.length - 1)];
        domIndex += 1;
        return result ?? reply({ ok: true, value: { matched: true, selector: "button", tag: "BUTTON" } });
      }
      if (isOAuthCapture(args[1])) return script.oauthCapture ?? reply({ ok: true, value: { clicked: true } });
      if (isOAuthRead(args[1])) return script.oauthRead ?? reply({ ok: true, value: { urls: ["https://github.com/login/oauth/authorize?client_id=x"] } });
      if (args[1].includes("location.href")) return script.oauthNavigate ?? reply({ ok: true, value: { navigating: true } });
      const states = script.settle ?? [];
      const result = states[Math.min(settleIndex, states.length - 1)];
      settleIndex += 1;
      return result ?? settle();
    }
    if (args[0] === "observe") {
      const observes = script.observes ?? [];
      const result = observes[Math.min(observeIndex, observes.length - 1)];
      observeIndex += 1;
      return result ?? reply(vom("L1 page"));
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
  return { run, calls, stops };
}

function assertStopped(script: ReturnType<typeof scriptRunner>) {
  assert.deepEqual(script.calls.at(-1), ["session", "stop", "abcd"]);
  assert.equal(script.stops.length, 1, "stop 分支必须实际返回，而非因 env 断言抛错被 finally 吞掉");
  assert.equal(script.stops[0]?.env, undefined, "清理命令不传 env");
}

const deps = (): CheckinDependencies => {
  const c = clock();
  return { now: c.now, sleep: c.sleep, dbFile: c.dbFile };
};

/** 新流程的快乐路径 observe 序列：公告→仪表盘→菜单→登录页→落地页→新余额仪表盘。 */
const happyObserves = () => [
  reply(observeWithAnnouncement),
  reply(observeConsole),
  reply(observeMenuOpen),
  reply(observeLoggedOut),
  reply(observeLanding),
  reply(observeDashboard("$580.18")),
];

for (const [name, stopOptions] of [
  ["非零退出", { exitCode: 1 }],
  ["调用抛错", { throws: true }],
] as const) {
  test(`checkin session stop ${name} → 报告 CLEANUP_INCOMPLETE，不掩盖签到结果`, async (t) => {
    const home = await fixture(t);
    const script = scriptRunner({ observes: happyObserves() });
    const reported: string[] = [];
    const stops: string[][] = [];
    const run: Runner = async (args, options) => {
      if (args[0] === "session" && args[1] === "stop") {
        stops.push(args);
        if (stopOptions.throws) throw new Error("bsk unavailable");
        return { stdout: "error", exitCode: stopOptions.exitCode };
      }
      return script.run(args, options);
    };
    const report = await checkinAccount(home, run, "work", 180_000, {
      ...deps(),
      report: (error) => reported.push(error.code),
    });
    assert.equal(report.ok, true, "清理失败不得改变签到结果");
    assert.deepEqual(reported, ["CLEANUP_INCOMPLETE"]);
    assert.deepEqual(stops, [["session", "stop", "abcd"]], "必须尝试关闭隔离窗口");
  });
}

test("checkin 总预算耗尽时仍执行 session stop（不因 remaining() 抛错而漏关窗口）", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({ observes: [reply(observeWithAnnouncement)] });
  const stops: string[][] = [];
  const run: Runner = async (args, options) => {
    if (args[0] === "session" && args[1] === "stop") {
      stops.push(args);
      assert.equal(options?.timeoutMs, 30_000, "stop 使用固定预算，不依赖剩余预算");
      return reply({ stopped: "abcd" });
    }
    return script.run(args, options);
  };
  await assert.rejects(checkinAccount(home, run, "work", 1_000, deps()), { code: "CHECKIN_TIMEOUT" });
  assert.deepEqual(stops, [["session", "stop", "abcd"]], "预算耗尽也必须关闭隔离窗口");
});

test("checkin 成功后写入数据库：含时间、余额与到账标记", async (t) => {
  const home = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "zenx-checkin-db-ok-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbFile = join(dir, "checkin.db");

  const script = scriptRunner({ observes: happyObserves() });
  await checkinAccount(home, script.run, "work", 180_000, { ...deps(), dbFile });
  const saved = listCheckins({}, dbFile);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].alias, "work");
  assert.equal(saved[0].identity, "github_16350");
  assert.equal(saved[0].ok, true);
  assert.equal(saved[0].balanceBefore, 555.18);
  assert.equal(saved[0].balanceAfter, 580.18);
  assert.equal(saved[0].credited, true);
  assert.equal(saved[0].errorCode, null);
  assert.ok(!Number.isNaN(Date.parse(saved[0].time)), "time 必须是可解析的时间戳");
});

test("checkin 失败也写入数据库并保留错误码", async (t) => {
  const home = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "zenx-checkin-db-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbFile = join(dir, "checkin.db");

  const script = scriptRunner({ observes: [reply(observeWithAnnouncement), reply(observeConsole.replace(/github_16350/g, "github_other"))] });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, { ...deps(), dbFile }), { code: "IDENTITY_MISMATCH" });
  const saved = listCheckins({}, dbFile);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ok, false);
  assert.equal(saved[0].errorCode, "IDENTITY_MISMATCH");
  assert.equal(saved[0].credited, false);
});

test("checkin 数据库写入失败不影响签到结果", async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, "blocker"), { recursive: true });
  // 用目录当数据库文件，写入必然失败。
  const dbFile = join(home, "blocker");
  const script = scriptRunner({ observes: happyObserves() });
  const report = await checkinAccount(home, script.run, "work", 180_000, { ...deps(), dbFile });
  assert.equal(report.ok, true, "数据库不可写不得改变签到结果");
});

test("checkin 测试默认不写项目根的真实数据库", async (t) => {
  const home = await fixture(t);
  const before = listCheckins({}, DEFAULT_DB_FILE).length;
  const script = scriptRunner({ observes: happyObserves() });
  await checkinAccount(home, script.run, "work", 180_000, deps());
  const after = listCheckins({}, DEFAULT_DB_FILE).length;
  assert.equal(after, before, "测试不得向项目根 zenxbrowser/checkin.db 追加记录");
});

// 刚拉起的 Edge Profile 首次 navigate 偶发失败（扩展握手未完成），应重试而非直接判死。
test("checkin 首次导航失败后重试成功，不报 SITE_TIMEOUT", async (t) => {
  const home = await fixture(t);
  const c = clock();
  const script = scriptRunner({
    navigates: [{ stdout: "error", exitCode: 1 }, reply("tab=1 reached=load")],
    observes: happyObserves(),
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, c)).ok, true);
  // 等待重试 2s → 导航成功后 settle 2s → 关闭公告后等待 500ms。
  assert.deepEqual(c.sleeps.slice(0, 3), [2_000, 2_000, 500]);
  // 起点导航失败 1 次 + 重试成功 1 次，加上签到确认那次导航，共 3 次。
  assert.equal(script.calls.filter((args) => args[0] === "navigate").length, 3, "首次失败后重试一次");
  assertStopped(script);
});

test("checkin 导航连续失败 → 重试耗尽后报 SITE_TIMEOUT", async (t) => {
  const home = await fixture(t);
  const c = clock();
  const script = scriptRunner({
    navigates: [{ stdout: "error", exitCode: 1 }],
    observes: [reply(observeWithAnnouncement)],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, c), { code: "SITE_TIMEOUT" });
  assert.equal(script.calls.filter((args) => args[0] === "navigate").length, 3, "最多三次尝试");
  assert.deepEqual(c.sleeps, [2_000, 2_000], "两次重试各等待一次，之后不再等待");
  assertStopped(script);
});

test("checkin 导航重试不突破总预算，耗尽报 CHECKIN_TIMEOUT", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    navigates: [{ stdout: "error", exitCode: 1 }],
    observes: [reply(observeWithAnnouncement)],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 3_000, deps()), { code: "CHECKIN_TIMEOUT" });
  assert.ok(script.calls.filter((args) => args[0] === "navigate").length < 3, "预算不足时不再继续重试");
  assertStopped(script);
});

test("checkin 快乐路径：控制台读余额→公告关闭→退出→重登→回控制台核对到账", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({ observes: happyObserves() });
  const report = await checkinAccount(home, script.run, "work", 180_000, deps());
  assert.equal(report.ok, true);
  assert.equal(report.identity, "github_16350");
  assert.equal(report.balanceBefore, 555.18);
  assert.equal(report.balanceAfter, 580.18);
  assert.equal(report.checkinCredited, true);
  assert.deepEqual(script.calls[1], ["session", "start", "--browser-id", edge.instance_id, "--width", "1280", "--height", "800", "--json"]);
  assert.equal(script.calls.filter((args) => args[0] === "navigate").length, 2, "起点与确认各导航一次控制台");
  const clicks = script.calls.filter((args) => args[0] === "click").map((args) => args[1]);
  assert.deepEqual(clicks, ["@e5", "@e110", "@e12"]);
  const hovers = script.calls.filter((args) => args[0] === "hover").map((args) => args[1]);
  assert.deepEqual(hovers, ["@e11"]);
  assertStopped(script);
});

test("checkin 英文界面同样走通：System Notice / exit Quit / Continue with GitHub", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeAnnouncementEn),
      reply(observeConsoleEn),
      reply(observeMenuOpenEn),
      reply(observeLoggedOutEn),
      reply(observeLanding),
      reply(observeDashboardEn),
    ],
  });
  const report = await checkinAccount(home, script.run, "work", 180_000, deps());
  assert.equal(report.ok, true);
  assert.equal(report.balanceBefore, 555.18);
  assert.equal(report.balanceAfter, 580.18);
  assert.equal(report.checkinCredited, true);
  const clicks = script.calls.filter((args) => args[0] === "click").map((args) => args[1]);
  // 与中文一致：优先点「关闭公告 / Close Notice」，其次才是「今日关闭 / Close Today」。
  assert.deepEqual(clicks, ["@e5", "@e110", "@e12"], "英文公告关闭、退出项、登录按钮都要能定位");
  assertStopped(script);
});

// 探测只认"能否求值"：窗口尺寸不再参与判定（后台 Edge 的 outerWidth 恒为 0 但页面照常渲染）。
for (const [name, windowResult] of [
  ["响应畸形 JSON", reply("{not-json")],
  ["缺少 value", reply({ ok: true })],
  ["visible 类型错误", reply({ ok: true, value: { visible: "false" } })],
  ["visible 缺失", reply({ ok: true, value: {} })],
  ["非零退出", { ...reply({ ok: true, value: { visible: true } }), exitCode: 1 }],
] as const) {
  test(`checkin 窗口探测失败（${name}）→ WINDOW_NOT_INTERACTIVE，禁止交互且 stop`, async (t) => {
    const home = await fixture(t);
    const script = scriptRunner({ window: windowResult, observes: [reply(observeWithAnnouncement)] });
    await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "WINDOW_NOT_INTERACTIVE" });
    assert.equal(script.calls.filter((args) => ["observe", "click", "hover"].includes(args[0])).length, 0, "探测失败不得交互");
    assertStopped(script);
  });
}

test("checkin 后台窗口 outerWidth 为 0 但页面可求值 → 走 DOM 直调完成签到", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false } }),
    observes: happyObserves(),
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true, "尺寸为 0 不得判死刑");
  assert.equal(script.calls.filter((args) => args[0] === "click").length, 0, "隐藏时走 DOM 直调");
  assertStopped(script);
});

for (const [name, windowResult, expectCdp] of [
  ["页面可见", reply({ ok: true, value: { visible: true, w: 1280, h: 800 } }), true],
  ["页面隐藏但尺寸有效", reply({ ok: true, value: { visible: false, w: 1280, h: 800 } }), false],
] as const) {
  test(`checkin 窗口可绘制（${name}）→ 通过预检并执行完签到`, async (t) => {
    const home = await fixture(t);
    const script = scriptRunner({ window: windowResult, observes: happyObserves() });
    assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
    // 可见走 CDP 点击，隐藏走 DOM 直调——两者互斥，同一流程只应命中其一。
    const cdpClicks = script.calls.filter((args) => args[0] === "click").length;
    const domClicks = script.calls.filter((args) => args[0] === "evaluate" && isDomInteract(args[1])).length;
    assert.equal(expectCdp ? cdpClicks > 0 : domClicks > 0, true, `${name} 应使用${expectCdp ? " CDP" : " DOM"}通道`);
    assert.equal(expectCdp ? domClicks : cdpClicks, 0, "两种输入通道不得混用");
    assertStopped(script);
  });
}

test("checkin 页面隐藏时全程走 DOM 直调：不调用 bsk click/hover", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false, w: 1280, h: 800 } }),
    observes: happyObserves(),
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  assert.equal(script.calls.filter((args) => args[0] === "click").length, 0, "隐藏时不得用 CDP 点击");
  assert.equal(script.calls.filter((args) => args[0] === "hover").length, 0, "隐藏时不得用 CDP 悬停");
  // 公告关闭、退出、GitHub 登录三步：登录那步是 OAuth 捕获 + 跳转，不是普通 DOM 点击。
  assert.equal(script.calls.filter((args) => args[0] === "evaluate" && isDomInteract(args[1])).length, 3);
  assertStopped(script);
});

test("checkin 页面隐藏时 GitHub 登录走捕获授权地址再同 tab 跳转", async (t) => {
  const home = await fixture(t);
  const oauthUrl = "https://github.com/login/oauth/authorize?client_id=Ov23li&state=abc";
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false, w: 1280, h: 800 } }),
    observes: happyObserves(),
    oauthRead: reply({ ok: true, value: { urls: [oauthUrl] } }),
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  const expressions = script.calls.filter((args) => args[0] === "evaluate").map((args) => args[1]);
  assert.equal(expressions.filter(isOAuthCapture).length, 1, "先捕获 window.open 的授权地址");
  assert.equal(expressions.filter(isOAuthRead).length, 1, "再读回捕获的地址");
  const navigate = expressions.find((expression) => expression.includes("location.href"));
  assert.ok(navigate, "必须用 location.href 跳转");
  assert.ok(navigate.includes(oauthUrl), "跳转到捕获到的真实授权地址");
  assertStopped(script);
});

test("checkin 页面隐藏且未捕获到授权地址 → LOGIN_TIMEOUT，不继续轮询", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false, w: 1280, h: 800 } }),
    observes: happyObserves(),
    oauthRead: reply({ ok: true, value: { urls: [] } }),
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "LOGIN_TIMEOUT" });
  const expressions = script.calls.filter((args) => args[0] === "evaluate").map((args) => args[1]);
  assert.equal(expressions.filter((expression) => expression.includes("location.href")).length, 0, "无地址不得跳转");
  assertStopped(script);
});

test("checkin 页面隐藏且 DOM 直调未命中元素 → DOM_INTERACT_FAILED", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false, w: 1280, h: 800 } }),
    observes: [reply(observeWithAnnouncement)],
    domInteracts: [reply({ ok: true, value: { matched: false } })],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "DOM_INTERACT_FAILED" });
  assertStopped(script);
});

test("checkin DOM 直调的标签剥离 VOM 状态与上下文标记", () => {
  const page: Parameters<typeof labelOfRef>[0] = { text: [
    "L1 page",
    '@e5 button "关闭公告"',
    '@e11 button "G github_16350 chevron_down [has-submenu]"',
    '@e110 menuitem "exit 退出"',
    '@e21 button "当前余额 $555.18" [ctx: 账户数据 当前余额 $555.18]',
  ].join("\n") };
  assert.equal(labelOfRef(page, "@e5"), "关闭公告");
  assert.equal(labelOfRef(page, "@e11"), "G github_16350 chevron_down");
  assert.equal(labelOfRef(page, "@e110"), "exit 退出");
  assert.equal(labelOfRef(page, "@e21"), "当前余额 $555.18");
  assert.equal(labelOfRef(page, "@e999"), undefined, "未知 ref 返回 undefined");
});

test("checkin 页面隐藏时标签取自 ref 对应文本，非硬编码", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false, w: 1280, h: 800 } }),
    observes: happyObserves(),
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  const labels = script.calls
    .filter((args) => args[0] === "evaluate" && isDomInteract(args[1]))
    .map((args) => /const target = ("(?:[^"\\]|\\.)*")/.exec(args[1])?.[1]);
  // VOM 的 [has-submenu] 是状态标记而非 DOM 文本，取标签时必须剥掉才能按文本命中元素。
  assert.deepEqual(labels, ['"关闭公告"', '"G github_16350 chevron_down"', '"exit 退出"']);
  assertStopped(script);
});

test("checkin 非 GitHub 登录来源（L=LinuxDO）账号同样识别用户菜单并完成签到", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zenx-checkin-linuxdo-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  const linuxdo: Account = { ...account, expectedIdentity: "linuxdo_25672" };
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [linuxdo] }));

  // 菜单前缀用 L（LinuxDO），其余结构与 GitHub 账号一致。
  const console_ = vom([
    'L1 page',
    '    @e11 button "L linuxdo_25672 chevron_down [has-submenu]"',
    '    main "早上好，linuxdo_25672 账户数据 当前余额 $476.10 历史消耗 $1248.90"',
  ].join("\n"));
  const landing = vom([
    'L1 page',
    '    @e11 button "L linuxdo_25672 chevron_down [has-submenu]"',
    '    main "统一的 大模型接口网关"',
  ].join("\n"));
  const dashboard = vom([
    'L1 page',
    '    @e11 button "L linuxdo_25672 chevron_down [has-submenu]"',
    '    @e22 button "当前余额 $501.10"',
  ].join("\n"));
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(console_),
      reply(observeMenuOpen.replace("github_16350", "linuxdo_25672")),
      reply(observeLoggedOut),
      reply(landing),
      reply(dashboard),
    ],
  });
  const report = await checkinAccount(home, script.run, "work", 180_000, deps());
  assert.equal(report.ok, true);
  assert.equal(report.identity, "linuxdo_25672");
  assert.equal(report.balanceBefore, 476.10);
  assert.equal(report.balanceAfter, 501.10);
  assert.equal(report.checkinCredited, true);
  assert.deepEqual(script.calls.filter((args) => args[0] === "click").map((args) => args[1]), ["@e5", "@e110", "@e12"]);
  assertStopped(script);
});

test("checkin 登录成功只认用户菜单，不要求落地页出现余额文本", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(observeLanding.replace(/当前余额[^\n]*/, "")),
      reply(observeDashboard("$580.18")),
    ],
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  assertStopped(script);
});

test("checkin 导航后先探测输入通道、收敛动画再 observe/click", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({ observes: happyObserves() });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  const navigateIndex = script.calls.findIndex((args) => args[0] === "navigate");
  assert.deepEqual(script.calls.slice(navigateIndex + 1, navigateIndex + 5).map((args) => args[0]),
    ["evaluate", "evaluate", "observe", "click"]);
  assert.equal(isWindowProbe(script.calls[navigateIndex + 1][1]), true, "导航后先做输入通道探测");
  assert.equal(script.calls[navigateIndex + 4][1], "@e5");
  // 预检可以读 visibilityState；但"收敛动画"这一步不得依赖它（隐藏页面动画同样要收敛）。
  const settleCalls = script.calls.filter((args) => args[0] === "evaluate" && args[1].includes("getAnimations"));
  assert.ok(settleCalls.length > 0);
  assert.ok(settleCalls.every((args) => !args[1].includes("visibilityState")), "收敛表达式不得依赖 visibilityState");
  assertStopped(script);
});

test("checkin 关闭公告后退场等待并再次收敛，不额外点击旧 ref", async (t) => {
  const home = await fixture(t);
  const c = clock();
  const script = scriptRunner({ observes: happyObserves() });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, c)).ok, true);
  const closeIndex = script.calls.findIndex((args) => args[0] === "click" && args[1] === "@e5");
  assert.deepEqual(script.calls.slice(closeIndex + 1, closeIndex + 3).map((args) => args[0]),
    ["evaluate", "observe"]);
  assert.equal(script.calls.filter((args) => args[0] === "click" && ["@e4", "@e5"].includes(args[1])).length, 1);
  assert.deepEqual(c.sleeps.slice(0, 2), [2_000, 500]);
  assertStopped(script);
});

test("checkin 公告第二次点击必须使用收敛后新 observe 的 ref", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeWithAnnouncement.replace("@e5", "@e55")),
      ...happyObserves().slice(1),
    ],
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  const closes = script.calls.filter((args) => args[0] === "click" && ["@e5", "@e55"].includes(args[1]));
  assert.deepEqual(closes.map((args) => args[1]), ["@e5", "@e55"]);
  const secondIndex = script.calls.indexOf(closes[1]);
  assert.deepEqual(script.calls.slice(secondIndex - 2, secondIndex).map((args) => args[0]), ["evaluate", "observe"]);
  assertStopped(script);
});

test("checkin 公告两次点击仍失败 → ANNOUNCEMENT_CLOSE_FAILED，最多两次且 stop", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeWithAnnouncement.replace("@e5", "@e55")),
      reply(observeWithAnnouncement.replace("@e5", "@e555")),
    ],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "ANNOUNCEMENT_CLOSE_FAILED" });
  assert.deepEqual(script.calls.filter((args) => args[0] === "click").map((args) => args[1]), ["@e5", "@e55"]);
  assert.equal(script.calls.filter((args) => args[0] === "observe").length, 3);
  assert.equal(script.calls.filter((args) => args[0] === "evaluate" && args[1].includes("getAnimations")).length, 3);
  assertStopped(script);
});

const invalidSettle: [string, Result][] = [
  ["畸形 JSON", reply("{not-json")],
  ["ok:false", reply({ ok: false, value: { finished: 0, events: 0 } })],
  ["缺少 ok", reply({ value: { finished: 0, events: 0 } })],
  ["ok 类型错误", reply({ ok: "true", value: { finished: 0, events: 0 } })],
  ["顶层 null", reply(null)],
  ["顶层数组", reply([])],
  ["缺少 value", reply({ ok: true })],
  ["value 为 null", reply({ ok: true, value: null })],
  ["value 为数组", reply({ ok: true, value: [] })],
  ["缺少 finished", reply({ ok: true, value: { events: 0 } })],
  ["finished 类型错误", reply({ ok: true, value: { finished: "0", events: 0 } })],
  ["缺少 events", reply({ ok: true, value: { finished: 0 } })],
  ["events 类型错误", reply({ ok: true, value: { finished: 0, events: "0" } })],
  ["非零退出即使内容有效", { ...settle(), exitCode: 1 }],
];

for (const [name, result] of invalidSettle) {
  test(`checkin evaluate ${name} → ANIMATION_SETTLE_FAILED，禁止交互且 stop`, async (t) => {
    const home = await fixture(t);
    const script = scriptRunner({ settle: [result], observes: [reply(observeWithAnnouncement)] });
    await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "ANIMATION_SETTLE_FAILED" });
    assert.equal(script.calls.filter((args) => args[0] === "evaluate" && args[1].includes("getAnimations")).length, 1, "非法响应不可重试");
    assert.equal(script.calls.filter((args) => ["observe", "click", "hover"].includes(args[0])).length, 0);
    assertStopped(script);
  });
}

test("checkin 动画收敛与公告重试共用总预算，耗尽报 CHECKIN_TIMEOUT", async (t) => {
  const home = await fixture(t);
  const c = clock();
  const start = c.now();
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeWithAnnouncement.replace("@e5", "@e55")),
    ],
  });
  const timeouts: number[] = [];
  const run: Runner = async (args, options) => {
    if (args[0] === "evaluate") {
      assert.ok(options?.timeoutMs && options.timeoutMs <= 2_600 - (c.now() - start));
      timeouts.push(options.timeoutMs);
    }
    return script.run(args, options);
  };
  await assert.rejects(checkinAccount(home, run, "work", 2_600, c), { code: "CHECKIN_TIMEOUT" });
  assert.deepEqual(c.sleeps, [2_000, 500, 500]);
  assert.deepEqual(timeouts, [600, 600, 100]);
  assert.deepEqual(script.calls.filter((args) => args[0] === "click").map((args) => args[1]), ["@e5", "@e55"]);
  assert.equal(script.calls.filter((args) => args[0] === "observe").length, 2);
  assertStopped(script);
});

test("checkin 收敛表达式 finish 有限动画并补发 animationend/transitionend", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({ observes: [reply(vom("L1 page"))] });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "IDENTITY_MISMATCH" });
  const expression = script.calls.find((args) => args[0] === "evaluate" && args[1].includes("getAnimations"))?.[1];
  assert.ok(expression, "通过真实 checkin 调用捕获表达式，不导出业务 helper");

  const dispatched: { type: string; animationName?: string; propertyName?: string }[] = [];
  class Element {
    dispatchEvent(event: { type: string; animationName?: string; propertyName?: string }) {
      dispatched.push(event);
      return true;
    }
  }
  class AnimationEvent {
    type: string;
    animationName?: string;
    constructor(type: string, init: { animationName?: string }) { this.type = type; this.animationName = init.animationName; }
  }
  class TransitionEvent {
    type: string;
    propertyName?: string;
    constructor(type: string, init: { propertyName?: string }) { this.type = type; this.propertyName = init.propertyName; }
  }
  class FakeAnimationBase {
    effect: { getTiming: () => { iterations: number }; target: unknown };
    finishCount = 0;
    throws: boolean;
    constructor(options: { iterations?: number; target?: unknown; throws?: boolean } = {}) {
      this.effect = {
        getTiming: () => ({ iterations: options.iterations ?? 1 }),
        target: "target" in options ? options.target : new Element(),
      };
      this.throws = options.throws ?? false;
    }
    finish() { if (this.throws) throw new Error("InvalidStateError"); this.finishCount += 1; }
  }
  class CSSAnimation extends FakeAnimationBase {
    animationName: string;
    constructor(name: string, options: { iterations?: number; target?: unknown; throws?: boolean } = {}) {
      super(options);
      this.animationName = name;
    }
  }
  class CSSTransition extends FakeAnimationBase {
    transitionProperty: string;
    constructor(property: string, options: { iterations?: number; target?: unknown; throws?: boolean } = {}) {
      super(options);
      this.transitionProperty = property;
    }
  }
  const animations = [
    new CSSAnimation("semi-modal-content-keyframe-hide"),
    new CSSAnimation("spin-forever", { iterations: Infinity }),
    new CSSAnimation("broken", { throws: true }),
    new CSSAnimation("orphan", { target: null }),
    new CSSTransition("opacity"),
  ];
  const document = { getAnimations: () => animations };
  const result = runInNewContext(expression, { document, Element, CSSAnimation, CSSTransition, AnimationEvent, TransitionEvent }, { timeout: 1_000 }) as { finished: number; events: number };

  assert.equal(result.finished, 3, "有限动画 finish：modal + orphan + transition；抛错的不计");
  assert.equal(result.events, 2, "只对带 Element 目标的成功动画补发事件");
  assert.deepEqual(dispatched.map((event) => event.type), ["animationend", "transitionend"]);
  assert.equal(dispatched[0]?.animationName, "semi-modal-content-keyframe-hide");
  assert.equal(dispatched[1]?.propertyName, "opacity");
  assert.equal(animations[0].finishCount, 1, "隐藏页冻结的退场动画被强制完成");
  assertStopped(script);
});

test("checkin DOM 直调表达式：按文本命中并调用 click，容忍 VOM 与 DOM 的文本差异", async (t) => {
  const home = await fixture(t);
  // 页面隐藏才会生成 DOM 直调表达式。
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false } }),
    observes: [reply(observeWithAnnouncement), reply(observeConsole)],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()));
  const expression = script.calls.find((args) => args[0] === "evaluate" && isDomInteract(args[1]))?.[1];
  assert.ok(expression, "通过真实 checkin 调用捕获表达式，不导出业务 helper");

  // 真实差异（实测 edge-7）：VOM 给 "G github_164295 chevron_down"，
  // DOM textContent 是相邻节点直接拼接的 "Ggithub_164295"（无空格、不含图标名）。
  const events: Record<string, string[]> = {};
  const makeNode = (name: string, text: string) => ({
    tagName: "BUTTON",
    textContent: text,
    getAttribute: () => null,
    dispatchEvent: (event: { type: string }) => { (events[name] ??= []).push(event.type); return true; },
    click: () => { (events[name] ??= []).push("click()"); },
  });
  const menu = makeNode("menu", "Ggithub_164295");
  const other = makeNode("other", "切换主题");
  const document = {
    querySelectorAll: (selector: string) => (selector === "button" ? [menu, other] : []),
  };
  const probe = expression.replace(
    /const target = ("(?:[^"\\]|\\.)*")/,
    'const target = "G github_164295 chevron_down"',
  );
  const result = runInNewContext(probe, { document, window: {}, PointerEvent: FakePointerEvent }, { timeout: 1_000 }) as { matched: boolean };
  assert.equal(result.matched, true, "图标词与空白差异均不得导致漏匹配");
  assert.deepEqual(Object.keys(events), ["menu"], "命中的必须是用户菜单按钮");
  // 点击必须补发完整的按下/抬起/click 序列：只调 node.click() 时 <a> 类菜单项不跳转。
  assert.deepEqual(events.menu, [
    "pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove",
    "pointerdown", "mousedown", "pointerup", "mouseup", "click", "click()",
  ]);
});

test("checkin DOM 直调表达式：图标名不得误命中无关链接（exit 命中 x.com 的回归）", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false } }),
    observes: [reply(observeWithAnnouncement), reply(observeConsole)],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()));
  const expression = script.calls.find((args) => args[0] === "evaluate" && isDomInteract(args[1]))?.[1];
  assert.ok(expression);

  // 真实页面上有 "https://x.com/AgentRouter" 这类链接：用"任一词互为子串"会让
  // 目标里的图标名 exit 命中 AgentRouter 里的 exit。必须靠中文片段定位。
  const events: Record<string, string[]> = {};
  const makeNode = (name: string, text: string, tag = "A") => ({
    tagName: tag,
    textContent: text,
    getAttribute: () => null,
    dispatchEvent: (event: { type: string }) => { (events[name] ??= []).push(event.type); return true; },
    click: () => { (events[name] ??= []).push("click()"); },
  });
  const twitter = makeNode("twitter", "https://x.com/AgentRouter");
  const logout = makeNode("logout", "退出", "LI");
  const document = {
    querySelectorAll: (selector: string) => {
      if (selector === "a") return [twitter];
      if (selector === "li") return [logout];
      return [];
    },
  };
  const probe = expression.replace(/const target = ("(?:[^"\\]|\\.)*")/, 'const target = "exit 退出"');
  const result = runInNewContext(probe, { document, window: {}, PointerEvent: FakePointerEvent }, { timeout: 1_000 }) as { matched: boolean };
  assert.equal(result.matched, true);
  assert.deepEqual(Object.keys(events), ["logout"], "必须点退出项，不得点到 x.com 链接");
});

test("checkin DOM 直调表达式：无匹配元素时返回 matched:false", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    window: reply({ ok: true, value: { visible: false } }),
    observes: [reply(observeWithAnnouncement), reply(observeConsole)],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()));
  const expression = script.calls.find((args) => args[0] === "evaluate" && isDomInteract(args[1]))?.[1];
  assert.ok(expression);
  const document = { querySelectorAll: () => [] };
  const result = runInNewContext(expression, { document, window: {}, PointerEvent: FakePointerEvent }, { timeout: 1_000 }) as { matched: boolean };
  assert.equal(result.matched, false, "未命中不得谎报成功");
});

test("checkin observe 页面正文包含 error: 字样不误判（实测公告曾含 trigger an error:）", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({ observes: happyObserves() });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  assertStopped(script);
});

test("checkin 登录轮询中的空观察占位符不中断轮询", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply("(empty observation — page may still be loading)"),
      reply(observeLanding),
      reply(observeDashboard("$580.18")),
    ],
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  assertStopped(script);
});

test("checkin 登录轮询落地页重现公告时自动关闭再核对菜单", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(observeWithAnnouncement.replace("@e5", "@e31")),
      reply(observeLanding),
      reply(observeDashboard("$580.18")),
    ],
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  const closeClicks = script.calls.filter((args) => args[0] === "click" && ["@e5", "@e31"].includes(args[1]));
  assert.deepEqual(closeClicks.map((args) => args[1]), ["@e5", "@e31"]);
  assertStopped(script);
});

for (const [name, stdout] of [
  ["错误行但退出码 0", "error: observe failed"],
  ["空输出", ""],
  ["无 @vom 头的裸树", "L1 page\n  @e1 button \"使用 GitHub 继续\""],
] as const) {
  test(`checkin observe 输出非 VOM 结构（${name}）→ SESSION_OBSERVE_INVALID`, async (t) => {
    const home = await fixture(t);
    const script = scriptRunner({ observes: [reply(stdout)] });
    await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "SESSION_OBSERVE_INVALID" });
    assert.equal(script.calls.filter((args) => args[0] === "click").length, 0);
    assertStopped(script);
  });
}

test("checkin 身份不匹配 → IDENTITY_MISMATCH 且无后续点击", async (t) => {
  const home = await fixture(t);
  const wrongIdentity = observeConsole.replace(/github_16350/g, "github_other");
  const script = scriptRunner({ observes: [reply(observeWithAnnouncement), reply(wrongIdentity)] });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "IDENTITY_MISMATCH" });
  assert.deepEqual(script.calls.filter((args) => args[0] === "click").map((args) => args[1]), ["@e5"], "仅公告关闭点击，身份不匹配不得继续");
  assertStopped(script);
});

test("checkin 菜单懒渲染时轮询等待退出项，hover 后不立即判定失败", async (t) => {
  const home = await fixture(t);
  // 首次 observe 仍停在未展开的控制台（下拉尚未挂载），第二次才出现退出项。
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(observeLanding),
      reply(observeDashboard("$580.18")),
    ],
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  const clicks = script.calls.filter((args) => args[0] === "click").map((args) => args[1]);
  assert.deepEqual(clicks, ["@e5", "@e110", "@e12"], "退出只点一次");
  assertStopped(script);
});

test("checkin 菜单始终不展开 → LOGOUT_FAILED，不点击退出项", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      ...Array.from({ length: 15 }, () => reply(observeConsole)),
    ],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "LOGOUT_FAILED" });
  const clicks = script.calls.filter((args) => args[0] === "click").map((args) => args[1]);
  assert.deepEqual(clicks, ["@e5"], "不得点击退出项");
  assertStopped(script);
});

test("checkin 退出后站点延迟跳转登录页时轮询等待，不误报 LOGOUT_FAILED", async (t) => {
  const home = await fixture(t);
  // 前 2 次轮询仍停在控制台（SPA 跳转未完成），第 3 次才到登录页。
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeConsole),
      reply(observeConsole),
      reply(observeLoggedOut),
      reply(observeLanding),
      reply(observeDashboard("$580.18")),
    ],
  });
  assert.equal((await checkinAccount(home, script.run, "work", 180_000, deps())).ok, true);
  const clicks = script.calls.filter((args) => args[0] === "click").map((args) => args[1]);
  assert.deepEqual(clicks, ["@e5", "@e110", "@e12"], "退出只点一次，不因延迟而重复点击");
  assertStopped(script);
});

test("checkin 退出后始终不出现登录页 → LOGOUT_FAILED 且不执行登录点击", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      ...Array.from({ length: 20 }, () => reply(observeConsole)),
    ],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "LOGOUT_FAILED" });
  const clicks = script.calls.filter((args) => args[0] === "click").map((args) => args[1]);
  assert.deepEqual(clicks, ["@e5", "@e110"], "不得点击 GitHub 登录按钮");
  assertStopped(script);
});

test("checkin 轮询遇 GitHub 授权页 → MANUAL_INTERVENTION_REQUIRED", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(vom('L1 page\n  heading "Sign in to GitHub"\n  @e1 button "Sign in"')),
    ],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "MANUAL_INTERVENTION_REQUIRED" });
  assertStopped(script);
});

test("checkin 轮询超时 → LOGIN_TIMEOUT", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      ...Array.from({ length: 40 }, () => reply(vom("L1 page\n  StaticText \"跳转中...\""))),
    ],
  });
  await assert.rejects(checkinAccount(home, script.run, "work", 180_000, deps()), { code: "LOGIN_TIMEOUT" });
  assertStopped(script);
});

test("checkin 余额未变且无签到提示 → CHECKIN_UNCONFIRMED", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(observeLanding),
      reply(observeDashboard("$555.18", false)),
    ],
  });
  const report = await checkinAccount(home, script.run, "work", 180_000, deps());
  assert.equal(report.ok, false);
  assert.equal(report.balanceBefore, 555.18);
  assert.equal(report.balanceAfter, 555.18);
  assert.equal(report.checkinCredited, false);
  assertStopped(script);
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

test("checkin 当天账本已确认到账 → 跳过，不启动隔离窗口也不再登录", async (t) => {
  const home = await fixture(t);
  const c = clock();
  insertCheckin({
    time: new Date().toISOString(), alias: "work", instanceId: edge.instance_id, identity: account.expectedIdentity,
    ok: true, balanceBefore: 555.18, balanceAfter: 580.18, credited: true, errorCode: null,
  }, c.dbFile);
  const { run, calls } = scriptRunner({ observes: happyObserves() });
  const report = await checkinAccount(home, run, "work", 180_000, c);
  assert.equal(report.ok, true);
  assert.equal((report as { skipped?: string }).skipped, "already_credited_today");
  assert.ok(!calls.some((args) => args[0] === "session"), "跳过不得启动 session");
  assert.equal(listCheckins({}, c.dbFile).length, 1, "跳过不入账，账本里仍只有原来那条");
});

test("checkin --force 忽略当天已到账，照常退出重登", async (t) => {
  const home = await fixture(t);
  const c = clock();
  insertCheckin({
    time: new Date().toISOString(), alias: "work", instanceId: edge.instance_id, identity: account.expectedIdentity,
    ok: true, balanceBefore: 555.18, balanceAfter: 580.18, credited: true, errorCode: null,
  }, c.dbFile);
  const script = scriptRunner({ observes: happyObserves() });
  const report = await checkinAccount(home, script.run, "work", 180_000, { ...c, force: true });
  assert.equal(report.ok, true);
  assert.equal((report as { skipped?: string }).skipped, undefined);
  assert.ok(script.calls.some((args) => args[0] === "hover"), "强制重跑必须真的展开用户菜单");
  assertStopped(script);
});

test("checkin 站点显示今日已签到 → 跳过退出重登，不展开菜单", async (t) => {
  const home = await fixture(t);
  const checkedIn = vom([
    "L1 page",
    '    @e11 button "G github_16350 chevron_down [has-submenu]"',
    '    main "👋晚上好，github_16350 账户数据 当前余额 $555.18"',
    '    StaticText "今日已签到"',
  ].join("\n"));
  const script = scriptRunner({ observes: [reply(checkedIn)] });
  const report = await checkinAccount(home, script.run, "work", 180_000, deps());
  assert.equal(report.ok, true);
  assert.equal((report as { skipped?: string }).skipped, "already_checked_in");
  assert.ok(!script.calls.some((args) => args[0] === "hover"), "已签到不得再展开菜单");
  assert.ok(!script.calls.some((args) => args[0] === "click"), "已签到不得点击退出");
  assertStopped(script);
});

// 回归：站点在当天重复登录时同样显示"签到成功"，只有余额真的涨了才算到账。
test("checkin 余额未变但有签到成功提示 → 不算到账，报 CHECKIN_UNCONFIRMED", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(observeLanding),
      reply(observeDashboard("$555.18", true)),
    ],
  });
  const c = clock();
  const report = await checkinAccount(home, script.run, "work", 180_000, c);
  assert.equal(report.ok, false);
  assert.equal((report as { code?: string }).code, "CHECKIN_UNCONFIRMED");
  assert.equal(report.checkinCredited, false);
  const saved = listCheckins({}, c.dbFile);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].errorCode, "CHECKIN_UNCONFIRMED", "未确认必须在账本里可区分");
  assertStopped(script);
});

test("checkin 离线写入账本（此前完全隐形）", async (t) => {
  const home = await fixture(t);
  const c = clock();
  const { run, calls } = scriptRunner({}, []);
  const report = await checkinAccount(home, run, "work", 180_000, c);
  assert.equal(report.ok, false);
  assert.equal((report as { connection: string }).connection, "offline");
  assert.ok(!calls.some((args) => args[0] === "session"), "离线不得启动 session");
  const saved = listCheckins({}, c.dbFile);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ok, false);
  assert.equal(saved[0].errorCode, "OFFLINE");
});

test("checkin session start 失败写入账本", async (t) => {
  const home = await fixture(t);
  const c = clock();
  const run: Runner = async (args) => {
    if (args[0] === "browsers") return reply([edge]);
    if (args[0] === "session" && args[1] === "start") return { stdout: "error: not found", exitCode: 1 };
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(checkinAccount(home, run, "work", 180_000, c), { code: "SESSION_START_FAILED" });
  const saved = listCheckins({}, c.dbFile);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].errorCode, "SESSION_START_FAILED");
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

test("CLI report 参数校验：非法端口、多余选项", async (t) => {
  const home = await fixture(t);
  const cases: [string[], string][] = [
    [["report", "--port", "0"], "INVALID_PORT"],
    [["report", "--port", "abc"], "INVALID_PORT"],
    [["report", "--port", "70000"], "INVALID_PORT"],
    [["report", "--timeout", "5m"], "INVALID_ARGUMENT"],
    [["report", "extra"], "INVALID_ARGUMENT"],
  ];
  for (const [args, code] of cases) {
    const lines: string[] = [];
    const exit = await main([...args, "--json", "--home", home], { output: (line) => lines.push(line) });
    assert.equal(exit, 1);
    assert.match(JSON.parse(lines[0]).error.code, new RegExp(code));
  }
});

test("CLI report 正常启动并响应 HTTP 请求", async (t) => {
  const home = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "zenx-report-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbFile = join(dir, "checkin.db");
  insertCheckin({ time: "2026-09-16T01:00:00Z", alias: "edge-1", instanceId: "i1", identity: "github_x", ok: true, balanceBefore: 100, balanceAfter: 125, credited: true, errorCode: null }, dbFile);

  const lines: string[] = [];
  const exitPromise = main(["report", "--port", "8899", "--json", "--home", home], {
    output: (line) => lines.push(line),
    reportDbFile: dbFile,
  });
  // 等服务器就绪再请求。
  let page = null as null | { ok: boolean; body: string };
  for (let i = 0; i < 20 && page === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const res = await fetch("http://127.0.0.1:8899/");
      page = { ok: res.ok, body: await res.text() };
    } catch { /* not ready yet */ }
  }
  assert.ok(page?.ok, "首页应可访问");
  assert.match(page!.body, /签到统计/, "网页应包含标题");
  const summary = await (await fetch("http://127.0.0.1:8899/api/summary")).json();
  assert.equal(summary[0].alias, "edge-1");
  assert.equal(summary[0].totalGained, 25);

  // 中断信号停止服务器，CLI 返回 0。
  process.emit("SIGINT" as NodeJS.Signals, "SIGINT");
  const exit = await exitPromise;
  assert.equal(exit, 0);
  assert.ok(lines.some((line) => line.includes("8899")), "应打印启动地址");
});

test("CLI checkin --help 提到新命令", async () => {
  const lines: string[] = [];
  await main(["--help"], { output: (line) => lines.push(line) });
  const help = lines.join("\n");
  assert.match(help, /accounts checkin <别名>/);
  assert.match(help, /checkin 执行完整退出重登签到流程/);
  assert.match(help, /支持无人值守/);
  assert.doesNotMatch(help, /不执行签到。$/);
});

/** 站点限流页：登录按钮还在，但站点明确给出"次数过多"。 */
const observeRateLimited = vom([
  'L1 page',
  '    @e12 button "github_logo 使用 GitHub 继续"',
  '    main "登录次数过多，请稍后再试"',
].join("\n"));

// 限流是站点侧共享配额，必须能从"登录超时"这类模糊症状里被认出来，
// 交给 checkin-all 冷却重试——否则继续跑只会把更多账号退出成登出态。
test("checkin 重登遇到站点限流 → 报 LOGIN_RATE_LIMITED 而非泛化 LOGIN_TIMEOUT", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [
      reply(observeWithAnnouncement),
      reply(observeConsole),
      reply(observeMenuOpen),
      reply(observeLoggedOut),
      reply(observeRateLimited),
    ],
  });
  await assert.rejects(
    checkinAccount(home, script.run, "work", 180_000, deps()),
    (error: unknown) => {
      const zenx = error as { code?: string; message?: string };
      return zenx.code === "LOGIN_RATE_LIMITED" && /登录次数过多/.test(zenx.message ?? "");
    },
    "应报 LOGIN_RATE_LIMITED，并在说明里带上站点给出的限流特征",
  );
  assertStopped(script);
});

/** 记录实例关闭调用，以及它与 session 回收的先后顺序。 */
function closeSpy(script: ReturnType<typeof scriptRunner>) {
  const closes: string[][] = [];
  const order: string[] = [];
  const run: Runner = async (args, options) => {
    if (args[0] === "browsers" && args[1] === "close") {
      closes.push(args);
      order.push("close");
      return {
        stdout: JSON.stringify({ browser_id: edge.instance_id, closed: true, windows_closed: 2, sessions_stopped: 1, disconnected: true }),
        exitCode: 0,
      };
    }
    if (args[0] === "session" && args[1] === "stop") order.push("stop");
    return script.run(args, options);
  };
  return { run, closes, order };
}

test("checkin --close-after：签到成功后关掉整个实例，且在 session 回收之后", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({ observes: happyObserves() });
  const spy = closeSpy(script);
  const report = await checkinAccount(home, spy.run, "work", 180_000, { ...deps(), closeAfter: true });
  assert.equal(report.ok, true);
  assert.equal(report.closed, true);
  assert.deepEqual(spy.closes, [["browsers", "close", "--browser-id", edge.instance_id, "--confirm", "--json"]]);
  assert.deepEqual(spy.order, ["stop", "close"], "先回收 session 再关实例：反过来会让 session stop 撞上已退出的进程，误报残留窗口");
});

test("checkin 不带 --close-after 时不动实例", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({ observes: happyObserves() });
  const spy = closeSpy(script);
  const report = await checkinAccount(home, spy.run, "work", 180_000, deps());
  assert.equal(report.ok, true);
  assert.equal(report.closed, undefined);
  assert.equal(spy.closes.length, 0);
});

test("checkin 失败时即使 --close-after 也保留实例（账号可能停在登出态）", async (t) => {
  const home = await fixture(t);
  const script = scriptRunner({
    observes: [reply(observeWithAnnouncement), reply(observeConsole.replace(/github_16350/g, "github_other"))],
  });
  const spy = closeSpy(script);
  await assert.rejects(
    checkinAccount(home, spy.run, "work", 180_000, { ...deps(), closeAfter: true }),
    (error: unknown) => (error as { code?: string }).code === "IDENTITY_MISMATCH",
  );
  assert.equal(spy.closes.length, 0, "失败要留着窗口供人工处理");
});
