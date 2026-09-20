import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { DEFAULT_DB_FILE, hasCreditedBetween, insertCheckin } from "./db.ts";
import { closeBrowser, findAccount } from "./launch.ts";
import type { LaunchDependencies } from "./launch.ts";
import { agentRouter } from "./sites/agentrouter.ts";

export type CheckinDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 用于报告清理阶段的问题（不覆盖签到主结果）。 */
  report?: (error: ZenxError) => void;
  /** 签到数据库；默认项目根 zenxbrowser/checkin.db。 */
  dbFile?: string;
  /** 忽略"今天已到账"的短路判断，强制执行一次退出重登（人工重试用）。 */
  force?: boolean;
  /**
   * 签到成功后连浏览器实例一起释放（停其全部会话 + 关其所有窗口）。
   * 默认关闭：只回收本次的隔离窗口，Edge 进程留着。
   */
  closeAfter?: boolean;
  /** closeAfter 用的依赖注入（测试替身）。 */
  closeDependencies?: LaunchDependencies;
};

const siteUrl = agentRouter.consoleUrl;
/** 签到后关闭实例的固定预算：不占签到总预算，避免总预算耗尽时关不掉。 */
const CLOSE_AFTER_TIMEOUT_MS = 45_000;
const SESSION_OBSERVE_MAX_LENGTH = 100_000;
const LOGIN_POLL_INTERVAL_MS = 2_000;
const LOGIN_POLL_BUDGET_MS = 60_000;
const PAGE_SETTLE_MS = 2_000;
const ANNOUNCEMENT_EXIT_SETTLE_MS = 500;
const LOGOUT_POLL_INTERVAL_MS = 1_000;
const LOGOUT_BUDGET_MS = 15_000;
/** 用户菜单 hover 后等待下拉挂载的轮询参数（见 ⑥ 退出）。 */
const MENU_OPEN_POLL_INTERVAL_MS = 500;
const MENU_OPEN_BUDGET_MS = 5_000;
/**
 * 首次 navigate 的重试次数与间隔。刚由 ensure-online 拉起的 Edge Profile，扩展可能
 * 还没完成握手，首次 navigate 偶发失败（实测 SITE_TIMEOUT，重跑即成功）。重试前
 * 短暂等待，让扩展连上；总预算仍由 remaining() 兜底，重试不会突破 --timeout。
 */
const NAVIGATE_ATTEMPTS = 3;
const NAVIGATE_RETRY_MS = 2_000;

/** 用于从 bsk 调用序列中识别"DOM 直调"表达式（测试与排障用）。 */
const DOM_INTERACT_MARKER = "zenx-dom-interact";
/** 用于识别"捕获 GitHub 授权地址"表达式。 */
const OAUTH_CAPTURE_MARKER = "zenx-oauth-capture";
/**
 * DOM 直调的候选元素组，按优先级排列。
 * 先 button/a 再 role=menuitem 最后 li：Semi Design 的下拉项常包在 li 里，
 * 直接取 li 会命中仍带同样文本的外层容器，.click() 打在容器上不触发行为。
 */
const DOM_INTERACT_GROUPS = ["button", "a", "[role=menuitem]", "[role=menuitemradio]", "li"];

/**
 * 输入通道。cdp 走 bsk click/hover（真实鼠标事件）；dom 走页面内 element.click()
 * 与合成指针事件。锁屏、无交互桌面、窗口被完全遮挡时页面恒为 hidden，
 * Windows 把鼠标事件派发给前台窗口，CDP 派发的输入被静默丢弃（实测：bsk 报告
 * click ok，坐标却与元素实际位置不符，页面毫无反应）。此时改为 DOM 直调。
 */
type InputMode = "cdp" | "dom";

// 强制把页面有限动画（公告弹窗、下拉菜单的入场/退场、余额滚动）收敛到终态，
// 使交互与读数不依赖渲染帧。隐藏页面（窗口最小化/被遮挡/锁屏）中动画时间线冻结：
// 1) finish() 把动画跳到终态（视觉/DOM 就位）；
// 2) 但 finish() 不派发 animationend/transitionend，组件库（Semi Design）依赖该事件
//    卸载退场中的弹窗——实测隐藏页中公告退场动画 finish 后弹窗永远留在 DOM，
//    因此必须补发合成事件触发卸载。无限循环的装饰动画跳过（finish 对其无效）。
// 收敛动画与输入通道无关：cdp 与 dom 两种通道都要先收敛再交互/读数。
const SETTLE_ANIMATIONS_EXPRESSION = `(() => {
  let finished = 0;
  let events = 0;
  for (const animation of document.getAnimations()) {
    const timing = animation.effect?.getTiming();
    if (!timing || timing.iterations === Infinity) continue;
    const target = animation.effect?.target;
    try { animation.finish(); finished += 1; } catch { continue; }
    if (!(target instanceof Element)) continue;
    if (animation instanceof CSSAnimation) {
      target.dispatchEvent(new AnimationEvent("animationend", { animationName: animation.animationName, bubbles: true }));
      events += 1;
    } else if (animation instanceof CSSTransition) {
      target.dispatchEvent(new TransitionEvent("transitionend", { propertyName: animation.transitionProperty, bubbles: true }));
      events += 1;
    }
  }
  return { finished, events };
})()`;

/**
 * 页面内共用的文本匹配器（生成为字符串，随表达式一起注入）。
 * VOM 的可访问名与 DOM 的 textContent 有三点系统性差异，逐个相等比必然漏匹配：
 * 1) 相邻节点拼接——"G" + "github_164295" 在 VOM 里是 "G github_164295"，DOM 里是 "Ggithub_164295"；
 * 2) 图标名会被算进可访问名——VOM 里的 "chevron_down" 只是 SVG 装饰，DOM textContent 里没有；
 * 3) 空白数量不一致。
 * 匹配策略（按可靠性降序，任一成立即命中）：
 * 1) 中文/数字片段优先：VOM 与 DOM 的中文文本一致，直接用子串比；"exit 退出" 取 "退出" 即可。
 * 2) 全串去空白后互为子串（"Ggithub_164295" ↔ "G github_164295 chevron_down" 的多余图标词不影响）。
 * 不能用"任一词互为子串"：图标名是普通英文词，"exit" 会命中 "https://x.com/AgentRouter"
 * 里的 "agentrouter"（实测点到了 Twitter 链接上）。
 */
const MATCHER_SOURCE = `
  const squash = (value) => String(value).toLowerCase().replace(/\\s+/g, "");
  const cjk = (value) => (String(value).match(/[\\u4e00-\\u9fff]+/g) || []);
  const wantedCjk = cjk(target);
  const wantedAll = squash(target);
  const hit = (node) => {
    const text = texts(node);
    if (text.length === 0) return false;
    if (wantedCjk.length > 0) {
      const own = cjk(text);
      return wantedCjk.some((word) => own.some((candidate) => candidate.includes(word) || word.includes(candidate)));
    }
    const own = squash(text);
    return own.length > 0 && (own.includes(wantedAll) || wantedAll.includes(own));
  };
`;

/**
 * DOM 直调：按标签文本在页面里找元素并直接调用 node.click()。
 * 用 VOM 标签文本而非 ref：ref 由 observe 生成且每次可能变化，dom 通道不需要坐标，
 * 直接按文本命中更稳。找不到目标时返回 matched:false，由调用方报错——绝不静默继续。
 */
function domInteractExpression(kind: "click" | "hover", label: string): string {
  // 点击不能只调 node.click()：实测退出项是 <a>，隐藏窗口里 .click() 不触发 SPA 路由跳转
  // （页面停在原地，既不跳登录页也不报错）。补发完整指针/鼠标序列后行为与真实点击一致。
  const dispatch = `const options = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
      for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
        node.dispatchEvent(new PointerEvent(type, options));
      }
      ${kind === "click" ? `for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        node.dispatchEvent(new PointerEvent(type, options));
      }
      if (typeof node.click === "function") node.click();` : ""}`;
  return `/* ${DOM_INTERACT_MARKER}:${kind} */ (() => {
  const target = ${JSON.stringify(label)};
  const groups = ${JSON.stringify(DOM_INTERACT_GROUPS)};
  const texts = (node) => [
    node.textContent || "",
    node.getAttribute ? (node.getAttribute("aria-label") || "") : "",
    node.getAttribute ? (node.getAttribute("title") || "") : "",
  ].join(" ").replace(/\\s+/g, " ").trim();
  ${MATCHER_SOURCE}
  for (const selector of groups) {
    for (const node of document.querySelectorAll(selector)) {
      if (!hit(node)) continue;
      ${dispatch}
      return { matched: true, selector, tag: node.tagName };
    }
  }
  return { matched: false };
})()`;
}

/**
 * 捕获 GitHub 授权地址：登录按钮走 window.open(oauthUrl)，隐藏窗口里 window.open
 * 返回 null，页面停在 /login 永远不跳转。这里临时替换 window.open 记录 URL 后触发点击，
 * 由调用方改用 location.href 跳转（同 tab 跳转不受弹窗拦截影响）。
 */
function oauthCaptureExpression(label: string): string {
  return `/* ${OAUTH_CAPTURE_MARKER}:capture */ (() => {
  const target = ${JSON.stringify(label)};
  const groups = ${JSON.stringify(DOM_INTERACT_GROUPS)};
  window.__zenxOpened = [];
  const original = window.open;
  window.open = (url) => { window.__zenxOpened.push(String(url)); return null; };
  setTimeout(() => { window.open = original; }, 3_000);
  const texts = (node) => [
    node.textContent || "",
    node.getAttribute ? (node.getAttribute("aria-label") || "") : "",
  ].join(" ").replace(/\\s+/g, " ").trim();
  ${MATCHER_SOURCE}
  for (const selector of groups) {
    for (const node of document.querySelectorAll(selector)) {
      if (!hit(node)) continue;
      node.click();
      return { clicked: true, selector };
    }
  }
  return { clicked: false };
})()`;
}

/** 读取被捕获的授权地址（上一步 oauth 捕获表达式的产物）。 */
const OAUTH_READ_EXPRESSION = `/* ${OAUTH_CAPTURE_MARKER}:read */ (() => {
  return { urls: window.__zenxOpened || [] };
})()`;

/** 跳转到捕获到的授权地址；同 tab 跳转，绕过被拦截的 window.open。 */
function oauthNavigateExpression(url: string): string {
  return `/* ${OAUTH_CAPTURE_MARKER}:navigate */ (() => {
  location.href = ${JSON.stringify(url)};
  return { navigating: true };
})()`;
}

/**
 * 站点登录限流特征。限流是**站点侧的共享配额**（同一出口 IP 连续登录若干次后触发），
 * 不是账号问题：此时站点只在页面上提示并拒绝跳转，UI 上的表现与"点击没生效"一样，
 * 唯一的症状是 LOGIN_TIMEOUT。认出它就交给 checkin-batch 冷却重试，避免继续把更多
 * 账号退出成登出态。特征清单在站点适配器里。
 */
function loginRateLimited(page: SessionPage): string | null {
  return agentRouter.classify.loginRateLimited(page.text);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSessionStart(raw: string): string {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ZenxError("SESSION_START_FAILED", "session start 响应不是有效 JSON；停止，不重试。"); }
  if (!object(value) || typeof value.session_id !== "string" || !/^[a-z0-9]{4,12}$/i.test(value.session_id)) {
    throw new ZenxError("SESSION_START_FAILED", "session start 响应缺少有效 session_id；停止，不重试。");
  }
  return value.session_id;
}

type SessionPage = { text: string };

/** bsk observe 页面尚未渲染时的占位输出（observe.rs Human 格式）。 */
const EMPTY_OBSERVATION_PLACEHOLDER = "(empty observation — page may still be loading)";

/** bsk observe（session 模式）的人读输出；取回整段正文用于状态判定。 */
function parseSessionObserve(stdout: string): SessionPage {
  if ([...stdout].length > SESSION_OBSERVE_MAX_LENGTH) {
    throw new ZenxError("SESSION_OBSERVE_INVALID", "observe 输出超长；停止，不重试。");
  }
  // bsk 的错误一律以非零退出码返回（observePage 已拦截）；成功输出恒以 @vom 开头，
  // 或为空观察占位符。不能用 "error:" 子串判断——页面正文可能包含任意文本
  // （实测 AgentRouter 公告内容曾包含 "trigger an error: ..." 导致误判）。
  const text = stdout.trim();
  if (!text.startsWith("@vom") && text !== EMPTY_OBSERVATION_PLACEHOLDER) {
    throw new ZenxError("SESSION_OBSERVE_INVALID", "observe 输出不是有效的 VOM 树；停止，不重试。");
  }
  return { text };
}

/** 从 observe 输出中按 `@eN button "标签"` 提取目标按钮 ref。 */
export function findRefByLabel(page: SessionPage, label: string): string | undefined {
  const pattern = new RegExp(`@(e\\d+)\\s+(?:button|link|menuitem)\\s+"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  const match = pattern.exec(page.text);
  return match ? `@${match[1]}` : undefined;
}

/**
 * 取 ref 对应的标签文本，用于 DOM 直调时按文本匹配元素。
 * VOM 行形如 `@e5 button "关闭公告"`、`@e110 menuitem "exit 退出"`；
 * 引号内即元素的可访问名。行尾的 `[has-submenu]`/`[expanded]` 与 `[ctx: ...]`
 * 是 VOM 附加的状态/上下文标记，不属于 DOM 文本，必须剥掉，否则按文本找不到元素。
 */
export function labelOfRef(page: SessionPage, ref: string): string | undefined {
  const id = ref.replace(/^@/, "");
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`@${escaped}\\s+\\w+\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(page.text);
  if (!match) return undefined;
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\s*\[(?:has-submenu|expanded|collapsed|pressed|checked|disabled|required|selected|focusable|multiselectable|readonly)\]/g, "")
    .replace(/\s*\[ctx:[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBalance(page: SessionPage): number | null {
  return agentRouter.parse.balance(page.text);
}

function hasAnnouncement(page: SessionPage): boolean {
  return agentRouter.classify.hasAnnouncement(page.text);
}

function alreadyCheckedIn(page: SessionPage): boolean {
  return agentRouter.classify.alreadyCheckedIn(page.text);
}

/** 本地"今天"对应的 UTC 区间 [start, end)；按本地日界切，避免 UTC 日界把早上算到前一天。 */
function todayUtcRange(now: Date): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function isLoggedOut(page: SessionPage): boolean {
  return agentRouter.classify.loggedOut(page.text);
}

function needsManualIntervention(page: SessionPage): string | null {
  return agentRouter.classify.manualIntervention(page.text);
}

function sessionCallArgs(sessionId: string, command: string[]): string[] {
  return [...command, "--session", sessionId];
}

async function runSessionCommand(
  run: Runner,
  sessionId: string,
  command: string[],
  remaining: () => number,
): Promise<{ stdout: string; exitCode: number }> {
  return run(sessionCallArgs(sessionId, command), {
    timeoutMs: Math.min(60_000, remaining()),
    env: { BSK_BROWSER_WAIT_MS: "0" },
  });
}

async function observePage(run: Runner, sessionId: string, remaining: () => number): Promise<SessionPage> {
  const reply = await runSessionCommand(run, sessionId, ["observe"], remaining);
  remaining();
  if (reply.exitCode !== 0) {
    throw new ZenxError("SESSION_OBSERVE_FAILED", `observe 失败（退出码 ${reply.exitCode}）；停止，不重试。`);
  }
  return parseSessionObserve(reply.stdout);
}

async function settleAnimations(
  run: Runner,
  sessionId: string,
  remaining: () => number,
): Promise<void> {
  const reply = await runSessionCommand(run, sessionId, ["evaluate", SETTLE_ANIMATIONS_EXPRESSION, "--json"], remaining);
  remaining();
  let result: unknown;
  try { result = JSON.parse(reply.stdout); }
  catch { throw new ZenxError("ANIMATION_SETTLE_FAILED", "动画收敛返回无效 JSON；停止，不点击。"); }
  if (reply.exitCode !== 0 || !object(result) || result.ok !== true || !object(result.value) ||
    typeof result.value.finished !== "number" || typeof result.value.events !== "number") {
    throw new ZenxError("ANIMATION_SETTLE_FAILED", "无法收敛页面动画；停止，不点击。");
  }
}

async function clickRef(
  run: Runner,
  sessionId: string,
  ref: string,
  remaining: () => number,
): Promise<void> {
  const reply = await runSessionCommand(run, sessionId, ["click", ref], remaining);
  remaining();
  if (reply.exitCode !== 0) {
    throw new ZenxError("SESSION_CLICK_FAILED", `点击 ${ref} 失败（退出码 ${reply.exitCode}）；停止，不重试。`);
  }
}

async function hoverRef(
  run: Runner,
  sessionId: string,
  ref: string,
  remaining: () => number,
): Promise<void> {
  const reply = await runSessionCommand(run, sessionId, ["hover", ref], remaining);
  remaining();
  if (reply.exitCode !== 0) {
    throw new ZenxError("SESSION_HOVER_FAILED", `悬停 ${ref} 失败（退出码 ${reply.exitCode}）；停止，不重试。`);
  }
}

async function evaluateJson(
  run: Runner,
  sessionId: string,
  expression: string,
  remaining: () => number,
): Promise<Record<string, unknown>> {
  const reply = await runSessionCommand(run, sessionId, ["evaluate", expression, "--json"], remaining);
  remaining();
  let result: unknown;
  try { result = JSON.parse(reply.stdout); }
  catch { throw new ZenxError("DOM_INTERACT_FAILED", "页面内求值返回无效 JSON；停止，不重试。"); }
  if (reply.exitCode !== 0 || !object(result) || result.ok !== true || !object(result.value)) {
    throw new ZenxError("DOM_INTERACT_FAILED", "页面内求值失败；停止，不重试。");
  }
  return result.value;
}

/** DOM 直调点击/悬停：按标签文本命中元素，直接派发事件。 */
async function domInteract(
  run: Runner,
  sessionId: string,
  kind: "click" | "hover",
  label: string,
  remaining: () => number,
): Promise<void> {
  const value = await evaluateJson(run, sessionId, domInteractExpression(kind, label), remaining);
  if (value.matched !== true) {
    throw new ZenxError("DOM_INTERACT_FAILED", `未能在页面中找到标签为「${label}」的元素；停止，不重试。`);
  }
}

function deadlineBudget(timeoutMs: number, deps: CheckinDependencies): () => number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ZenxError("INVALID_TIMEOUT", "签到预算必须是 1–300000 毫秒的整数。");
  }
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  return () => {
    const budget = Math.floor(deadline - now());
    if (budget < 1) throw new ZenxError("CHECKIN_TIMEOUT", "签到总预算已耗尽；停止，不重试。");
    return budget;
  };
}

/**
 * 把一次签到结果写入数据库（成功与失败都记，失败也要留痕）。
 * 账本写入失败绝不能改变签到结果，因此对外静默。
 */
async function recordCheckin(
  account: Account,
  result: { ok: boolean; balanceBefore: number | null; balanceAfter: number | null; checkinCredited: boolean; code?: string } | null,
  error: unknown,
  dbFile?: string,
): Promise<void> {
  try {
    insertCheckin({
      time: new Date().toISOString(),
      alias: account.alias,
      instanceId: account.instanceId,
      identity: account.expectedIdentity,
      ok: result?.ok ?? false,
      balanceBefore: result?.balanceBefore ?? null,
      balanceAfter: result?.balanceAfter ?? null,
      credited: result?.checkinCredited ?? false,
      // 流程跑完但没确认到账时（CHECKIN_UNCONFIRMED）也要留下错误码，
      // 否则账本里和"其它无码失败"无法区分。
      errorCode: result?.code ?? (error instanceof ZenxError ? error.code : error instanceof Error ? "COMMAND_FAILED" : null),
    }, dbFile ?? DEFAULT_DB_FILE);
  } catch {
    // 数据库写入失败不影响签到结果。
  }
}

export type CheckinResult = {
  ok: boolean;
  alias: string;
  instanceId: string;
  identity: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  checkinCredited: boolean;
  /** 流程跑完但未确认到账（余额未增长且无提示）。 */
  code?: string;
  /** 当天已到账/已签到而跳过退出重登；跳过不入账（不是一次签到）。 */
  skipped?: "already_credited_today" | "already_checked_in";
  /** --close-after 是否真的关掉了浏览器实例（未开该选项时为 undefined）。 */
  closed?: boolean;
  /** 关闭失败的原因；结果里保留，便于人工收尾。 */
  closureError?: string;
};

export async function checkinAccount(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 180_000,
  dependencies: CheckinDependencies = {},
) {
  const remaining = deadlineBudget(timeoutMs, dependencies);
  const sleep = dependencies.sleep ?? delay;
  return withStoreLock(home, async () => {
    const store = await readStore(home);
    const account = findAccount(store, alias);

    // ① 前置检查：离线/错浏览器/协议不符直接返回，不启动 session。
    const browsers = await listBrowsers(run, {
      timeoutMs: Math.min(60_000, remaining()),
      env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    const browser = browsers.find((item) => item.instance_id === account.instanceId);
    const connection = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";
    if (connection !== "online") {
      // 早退也要留痕：离线/非 Edge/协议不符在账本里曾经完全隐形（查不到记录，只能猜）。
      const error = new ZenxError(connection.toUpperCase(), `账号未通过前置检查（${connection}）；未启动隔离窗口，不重试。`);
      await recordCheckin(account, null, error, dependencies.dbFile);
      return { ok: false, alias: account.alias, instanceId: account.instanceId, connection, identity: "not_verified" };
    }

    // ①b 今天已到账 → 跳过。站点每日只发一次额度，重复跑只会白扣一次登录配额
    // （约 10 次连续登录就会触发站点限流），且拿不到钱。判据用账本里"今天已确认到账"的
    // 记录：credited 现在只在余额真实增长时才置位，可信。--force 用于人工重跑。
    if (dependencies.force !== true) {
      const { start, end } = todayUtcRange(new Date());
      let creditedToday = false;
      try { creditedToday = hasCreditedBetween(account.alias, start, end, dependencies.dbFile); }
      catch { creditedToday = false; }  // 账本读不了就照常签到，宁可多跑也不漏跑
      if (creditedToday) {
        return {
          ok: true,
          alias: account.alias,
          instanceId: account.instanceId,
          identity: account.expectedIdentity,
          balanceBefore: null,
          balanceAfter: null,
          checkinCredited: true,
          skipped: "already_credited_today" as const,
        };
      }
    }

    // ② 创建隔离窗口：显式尺寸。原因：窗口尺寸为 0 意味着连 DOM 求值都不可靠（无渲染表面），
    // 显式尺寸避免 Chrome 在浏览器整体后台时把新窗口创建为最小化。
    // 至于页面是否"可见"，不再作为硬性门槛——隐藏时自动改用 DOM 直调（见 probeWindow）。
    const startReply = await run(
      ["session", "start", "--browser-id", account.instanceId, "--width", "1280", "--height", "800", "--json"],
      { timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" } },
    );
    remaining();
    if (startReply.exitCode !== 0) {
      const error = new ZenxError("SESSION_START_FAILED", `session start 退出码 ${startReply.exitCode}；停止，不重试。`);
      await recordCheckin(account, null, error, dependencies.dbFile);
      throw error;
    }
    let sessionId: string;
    try {
      sessionId = parseSessionStart(startReply.stdout);
    } catch (error) {
      // 响应畸形时窗口其实已经建了，但没有 id 可回收——只能如实记账并提示人工关窗。
      await recordCheckin(account, null, error, dependencies.dbFile);
      throw error;
    }

    // 清理问题不打断签到结果，但必须让用户知道窗口可能残留。
    const report = dependencies.report ?? ((error: ZenxError) => console.error(`${error.code}: ${error.message}`));
    let result: CheckinResult;
    try {
      result = await runCheckinSteps(
        run, sessionId, account, remaining, sleep,
        dependencies.now ?? (() => performance.now()), dependencies.force === true,
      );
      // 跳过不入账：它不构成一次签到，记进账本只会虚增打卡次数与成功率。
      if (result.skipped === undefined) await recordCheckin(account, result, null, dependencies.dbFile);
    } catch (error) {
      await recordCheckin(account, null, error, dependencies.dbFile);
      throw error;
    } finally {
      // 无论成败必定回收 session，否则隔离窗口会残留在桌面上。
      // stop 用固定预算且不依赖 remaining()：总预算耗尽时 remaining() 本身会抛错，
      // 反而导致窗口关不掉；失败也不覆盖原始错误，但要如实报出残留窗口。
      try {
        const stopReply = await run(["session", "stop", sessionId], { timeoutMs: 30_000 });
        if (stopReply.exitCode !== 0) {
          report(new ZenxError("CLEANUP_INCOMPLETE", `签到隔离窗口可能未关闭（session stop 退出码 ${stopReply.exitCode}）；请手动关闭该 Edge 窗口。`));
        }
      } catch {
        report(new ZenxError("CLEANUP_INCOMPLETE", "签到隔离窗口可能未关闭（session stop 调用失败）；请手动关闭该 Edge 窗口。"));
      }
    }

    // --close-after：走到这里说明签到成功，回收 session 之后再把整个实例关掉。
    // 只放在成功路径：失败的账号常停在登出态，留着窗口便于人工处理；
    // 且 session stop 已经先跑完，不会因为实例先退出而误报 CLEANUP_INCOMPLETE。
    if (dependencies.closeAfter !== true) return result;
    const closure = await closeInstanceAfterCheckin(home, run, alias, dependencies);
    return { ...result, closed: closure.closed, closureError: closure.error };
  });
}

/**
 * 释放签到用的浏览器实例。关闭结果只写进报告，不改变签到结论——
 * 关不掉也只是资源没释放，钱已经领到了。
 */
async function closeInstanceAfterCheckin(
  home: string,
  run: Runner,
  alias: string,
  dependencies: CheckinDependencies,
): Promise<{ closed: boolean; error?: string }> {
  try {
    const reply = await closeBrowser(home, run, alias, CLOSE_AFTER_TIMEOUT_MS, dependencies.closeDependencies);
    if (reply.disconnected || reply.closed) return { closed: true };
    return { closed: false, error: "实例仍处于连接状态；未关闭。" };
  } catch (error) {
    const message = error instanceof ZenxError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "关闭失败。";
    return { closed: false, error: message };
  }
}

async function runCheckinSteps(
  run: Runner,
  sessionId: string,
  account: Account,
  remaining: () => number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  force: boolean,
): Promise<CheckinResult> {
  // 用户菜单按钮形如 `@e11 button "G github_16350 chevron_down [has-submenu]"`。
  // 首字母是登录来源标识（G=GitHub、L=LinuxDO 等），同一个站点账号可能通过多种方式登录，
  // 因此不固定前缀，只要求单个非空白字符后紧跟身份。
  const menuPattern = new RegExp(`@(e\\d+)\\s+button\\s+"\\S\\s+${account.expectedIdentity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+chevron_down`);

  const observeSettled = async () => {
    await settleAnimations(run, sessionId, remaining);
    return observePage(run, sessionId, remaining);
  };

  // 收敛动画后观察；公告弹窗在每次页面加载后重现（首页/控制台），存在则关闭（≤2 次点击）再观察。
  // 隐藏页面中退场动画依赖 settle 补发的 animationend 才能卸载弹窗。
  const preparePage = async (
    click: (page: SessionPage, ref: string) => Promise<void>,
  ): Promise<SessionPage> => {
    let page = await observeSettled();
    if (!hasAnnouncement(page)) return page;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // 按钮文案随界面语言变化，先中文后英文（站点两套文案都实测出现过）。
      const closeRef =
        findRefByLabel(page, "关闭公告") ??
        findRefByLabel(page, "今日关闭") ??
        findRefByLabel(page, "Close Notice") ??
        findRefByLabel(page, "Close Today");
      if (!closeRef) throw new ZenxError("ANNOUNCEMENT_CLOSE_FAILED", "公告弹窗存在但未找到关闭按钮 ref；停止，不重试。");
      await click(page, closeRef);
      await sleep(ANNOUNCEMENT_EXIT_SETTLE_MS);
      page = await observeSettled();
      if (!hasAnnouncement(page)) return page;
    }
    throw new ZenxError("ANNOUNCEMENT_CLOSE_FAILED", "两次点击后公告弹窗仍在；停止，不重试。");
  };

  const navigateConsole = async () => {
    for (let attempt = 1; ; attempt++) {
      const reply = await runSessionCommand(run, sessionId, ["navigate", siteUrl], remaining);
      remaining();
      if (reply.exitCode === 0) {
        await sleep(PAGE_SETTLE_MS);
        return;
      }
      if (attempt >= NAVIGATE_ATTEMPTS) {
        throw new ZenxError("SITE_TIMEOUT", `导航到 AgentRouter 控制台失败（${NAVIGATE_ATTEMPTS} 次尝试）；停止，不重试。`);
      }
      await sleep(NAVIGATE_RETRY_MS);
    }
  };

  // 输入通道探测：页面可见时用 bsk click/hover（真实 CDP 输入）；页面隐藏时用 DOM 直调。
  // 隐藏（锁屏、无交互桌面、窗口被完全遮挡）时 Windows 把鼠标事件交给前台窗口，
  // CDP 派发的输入被静默丢弃——bsk 仍报 click ok，但坐标与元素实际位置不符，页面无反应。
  // 此时页面内 element.click() 不受影响，改用 DOM 直调。
  const probeWindow = async (): Promise<{ visible: boolean }> => {
    const reply = await runSessionCommand(
      run,
      sessionId,
      ["evaluate", `/* ${DOM_INTERACT_MARKER}:probe */ (() => ({ visible: document.visibilityState === "visible" }))()`, "--json"],
      remaining,
    );
    remaining();
    let result: unknown;
    try { result = JSON.parse(reply.stdout); }
    catch { throw new ZenxError("WINDOW_NOT_INTERACTIVE", "无法检查隔离窗口状态；停止，不点击。"); }
    if (reply.exitCode !== 0 || !object(result) || result.ok !== true || !object(result.value) ||
      typeof result.value.visible !== "boolean") {
      throw new ZenxError("WINDOW_NOT_INTERACTIVE", "无法检查隔离窗口状态；停止，不点击。");
    }
    return { visible: result.value.visible };
  };

  // ② 打开控制台仪表盘（登录身份与"当前余额"所在页）。先导航再探测：
  // 空白页的 visibilityState 不代表目标页面的状态。
  await navigateConsole();

  // 探测不再以窗口尺寸为门槛。实测 Edge 在后台/无交互桌面时 outerWidth/outerHeight 恒为 0，
  // 但页面仍在正常渲染（innerWidth 1256），evaluate 与 DOM 交互完全可用——按尺寸判死刑会
  // 误杀无人值守场景。真正不可用的判据是求值本身失败，那已由下面的 JSON/退出码校验兜住。
  const windowState = await probeWindow();
  const mode: InputMode = windowState.visible ? "cdp" : "dom";

  // 按输入通道分发：cdp 用 ref + bsk 命令，dom 用标签文本 + 页面内事件。
  const clickTarget = async (page: SessionPage, ref: string) => {
    if (mode === "cdp") return clickRef(run, sessionId, ref, remaining);
    const label = labelOfRef(page, ref);
    if (!label) throw new ZenxError("DOM_INTERACT_FAILED", `无法取得 ${ref} 的标签文本；停止，不重试。`);
    return domInteract(run, sessionId, "click", label, remaining);
  };
  const hoverTarget = async (page: SessionPage, ref: string) => {
    if (mode === "cdp") return hoverRef(run, sessionId, ref, remaining);
    const label = labelOfRef(page, ref);
    if (!label) throw new ZenxError("DOM_INTERACT_FAILED", `无法取得 ${ref} 的标签文本；停止，不重试。`);
    return domInteract(run, sessionId, "hover", label, remaining);
  };

  // GitHub 登录按钮走 window.open(授权地址)，隐藏窗口里 window.open 被浏览器返回 null，
  // 页面停在 /login 永远不跳转。隐藏时先捕获授权地址，再用 location.href 同 tab 跳转；
  // 可见时 window.open 正常弹出授权窗口，保持 CDP 点击即可。
  const startGitHubLogin = async (page: SessionPage, ref: string) => {
    if (mode === "cdp") return clickRef(run, sessionId, ref, remaining);
    const label = labelOfRef(page, ref);
    if (!label) throw new ZenxError("DOM_INTERACT_FAILED", `无法取得 ${ref} 的标签文本；停止，不重试。`);
    await evaluateJson(run, sessionId, oauthCaptureExpression(label), remaining);
    await sleep(LOGIN_POLL_INTERVAL_MS);
    const captured = await evaluateJson(run, sessionId, OAUTH_READ_EXPRESSION, remaining);
    const urls = Array.isArray(captured.urls) ? captured.urls : [];
    const url = urls.find((item): item is string => typeof item === "string" && item.startsWith("https://github.com/"));
    if (!url) {
      throw new ZenxError("LOGIN_TIMEOUT", "未能捕获 GitHub 授权地址（window.open 未触发）；停止，不重试。", { alias: account.alias });
    }
    await evaluateJson(run, sessionId, oauthNavigateExpression(url), remaining);
  };

  let page = await preparePage(clickTarget);

  // ④ 身份验证（红线：不匹配立即停止）。
  if (!page.text.includes(account.expectedIdentity)) {
    throw new ZenxError("IDENTITY_MISMATCH", `控制台正文未包含预期身份 ${account.expectedIdentity}；立即停止，不执行退出。若该账号当前未登录，请先人工登录后再执行签到。`, { alias: account.alias });
  }

  // ⑤ 记录退出前余额。
  const balanceBefore = extractBalance(page);

  // ⑤b 站点自己显示"今日已签到" → 不必再退出重登，直接跳过（--force 可强制）。
  if (force !== true && alreadyCheckedIn(page)) {
    return {
      ok: true,
      alias: account.alias,
      instanceId: account.instanceId,
      identity: account.expectedIdentity,
      balanceBefore,
      balanceAfter: balanceBefore,
      checkinCredited: true,
      skipped: "already_checked_in" as const,
    };
  }

  // ⑥ 退出：hover 用户菜单 → click 退出。
  const menuRef = menuPattern.exec(page.text);
  if (!menuRef) throw new ZenxError("LOGOUT_FAILED", "未找到用户菜单按钮 ref；停止，不重试。");
  await settleAnimations(run, sessionId, remaining);
  await hoverTarget(page, `@${menuRef[1]}`);

  // 菜单是懒渲染的，且入场动画很关键：hover 后立刻 settleAnimations 会把入场动画 finish
  // 并补发 animationend，Semi Design 收到后立刻卸载——下拉再也不会出现（实测：settle 组
  // 菜单 8 次轮询都不出现，不 settle 组约 1s 后出现）。因此这里只 observe，不 settle。
  const menuDeadline = now() + MENU_OPEN_BUDGET_MS;
  let logoutRef: string | undefined;
  while (true) {
    page = await observePage(run, sessionId, remaining);
    // 退出项的可访问名是「图标名 + 文案」，中文界面 "exit 退出"、英文界面 "exit Quit"。
    logoutRef = findRefByLabel(page, "exit 退出") ?? findRefByLabel(page, "exit Quit");
    if (logoutRef || now() >= menuDeadline) break;
    await sleep(MENU_OPEN_POLL_INTERVAL_MS);
  }

  if (!logoutRef) throw new ZenxError("LOGOUT_FAILED", `菜单展开后 ${MENU_OPEN_BUDGET_MS / 1000}s 内未找到退出项 ref；停止，不重试。`);
  await clickTarget(page, logoutRef);

  // 退出后站点要经 SPA 路由跳转才到登录页（实测约 1.5s）。只看一次 observe 会仍在控制台，
  // 误报 LOGOUT_FAILED——此时退出其实已经生效，重跑会遇到"未登录"状态。改为轮询等待。
  const logoutDeadline = now() + LOGOUT_BUDGET_MS;
  let loggedOut = false;
  while (now() < logoutDeadline) {
    await sleep(LOGOUT_POLL_INTERVAL_MS);
    page = await observeSettled();
    if (isLoggedOut(page)) { loggedOut = true; break; }
  }
  if (!loggedOut) throw new ZenxError("LOGOUT_FAILED", `点击退出后 ${LOGOUT_BUDGET_MS / 1000}s 内未见登录页；停止，不重试。`);

  // ⑦ 重新登录：GitHub OAuth 轮询。落地页不定（首页/控制台），公告可能重现；
  // 登录成功的标志是用户菜单按钮（G <身份> chevron）出现——余额已不在落地页，
  // 到账核对统一放在 ⑧ 的控制台余额对比。
  // 登录按钮同理分中英文。findRefByLabel 按可访问名前缀匹配，而可访问名带图标名
  //（"github_logo …"），所以英文要把图标名一起带上；末项是图标名缺失时的兜底。
  const githubRef =
    findRefByLabel(page, "github_logo 使用 GitHub 继续") ??
    findRefByLabel(page, "github_logo Continue with GitHub") ??
    findRefByLabel(page, "Continue with GitHub");
  if (!githubRef) throw new ZenxError("LOGIN_TIMEOUT", "登录页未找到 GitHub 登录按钮 ref；停止，不重试。", { alias: account.alias });
  await startGitHubLogin(page, githubRef);

  const loginDeadline = now() + LOGIN_POLL_BUDGET_MS;
  let loggedIn = false;
  let sawCheckinSuccess = false;
  while (now() < loginDeadline) {
    await sleep(LOGIN_POLL_INTERVAL_MS);
    page = await preparePage(clickTarget);
    sawCheckinSuccess = sawCheckinSuccess || page.text.includes("签到成功");
    const limited = loginRateLimited(page);
    if (limited) {
      throw new ZenxError("LOGIN_RATE_LIMITED", `站点登录限流（${limited}）；停止本次重登，等待冷却后由 checkin-all 自动重试。`, { pageFeature: limited });
    }
    const manual = needsManualIntervention(page);
    if (manual) {
      throw new ZenxError("MANUAL_INTERVENTION_REQUIRED", `检测到需要人工处理的页面特征（${manual}）；停止，请人工完成登录后重试。`, { pageFeature: manual });
    }
    if (menuPattern.test(page.text)) { loggedIn = true; break; }
  }
  if (!loggedIn) throw new ZenxError("LOGIN_TIMEOUT", "重新登录轮询超时（60s）；停止，不重试。", { alias: account.alias });

  // ⑧ 签到确认：回控制台仪表盘读新余额。
  await navigateConsole();
  page = await preparePage(clickTarget);
  const balanceAfter = extractBalance(page);
  const hasCheckinSuccess = sawCheckinSuccess || page.text.includes("签到成功");
  // 余额两端都读到时只认真实增长："签到成功"只是动作提示，实测当天重复登录也照样出现
  // （账本里 10/15 条成功记录余额零增长），拿它当到账判据会批量制造假成功。
  // 只有余额读不到（页面没渲染出余额）时才退回文本信号，此时结果标为未确认。
  const checkinCredited = balanceBefore !== null && balanceAfter !== null
    ? balanceAfter > balanceBefore
    : hasCheckinSuccess;
  if (!checkinCredited) {
    return {
      ok: false,
      alias: account.alias,
      instanceId: account.instanceId,
      identity: account.expectedIdentity,
      balanceBefore,
      balanceAfter,
      checkinCredited: false,
      code: "CHECKIN_UNCONFIRMED",
    };
  }
  return {
    ok: true,
    alias: account.alias,
    instanceId: account.instanceId,
    identity: account.expectedIdentity,
    balanceBefore,
    balanceAfter,
    checkinCredited: true,
  };
}
