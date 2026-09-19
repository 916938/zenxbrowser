import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";
import { extractBalance } from "./console.ts";
import { findAccount } from "./launch.ts";
import { agentRouter } from "./sites/agentrouter.ts";

const siteUrl = agentRouter.consoleUrl;
const PAGE_SETTLE_MS = 2_000;
const LOGIN_POLL_INTERVAL_MS = 3_000;
const LOGIN_POLL_BUDGET_MS = 120_000;
const TEXT_MAX_LENGTH = 20_000;
/**
 * 登录按钮文案：界面语言因账号而异，中文 "使用 GitHub 继续"、英文 "Continue with GitHub"。
 * 匹配按序尝试——DOM 直调走子串命中，两套文案都能命中各自的元素。
 */
const GITHUB_LOGIN_LABELS = ["使用 GitHub 继续", "Continue with GitHub"];
// GitHub 授权页与登录限流的文案特征改由站点适配器统一提供（src/sites/agentrouter.ts）。
/** 站点登录页特征，用于确认"确实已登出"而不是别的异常页面。 */
const LOGGED_OUT_PATTERNS = ["使用 GitHub 继续", "使用 LinuxDO 继续", "登 录", "登录", "Continue with GitHub"];

export type LoginDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  dbFile?: string;
};

export type LoginResult = {
  ok: boolean;
  alias: string;
  instanceId: string;
  identity: string;
  connection: "online" | "offline" | "wrong_browser" | "unsupported_protocol";
  /** 进入流程时是否已处于登录态（已登录则不点击登录按钮）。 */
  alreadyLoggedIn: boolean;
  balance: number | null;
  /** 失败时的错误码。 */
  code?: string;
};

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

function detectRateLimit(text: string): string | null {
  return agentRouter.classify.loginRateLimited(text);
}

function detectManualIntervention(text: string): string | null {
  return agentRouter.classify.manualIntervention(text);
}

/**
 * DOM 直调：按部分标签文本命中登录按钮并派发完整指针序列。
 * 与 checkin 同源的思路——隐藏窗口里 CDP 派发的输入会被静默丢弃，页面内事件不受影响。
 * 同时替换 window.open 捕获授权地址：登录按钮走 window.open，隐藏窗口里它恒返回 null，
 * 页面会停在登录页永不跳转。
 */
function domLoginClickExpression(label: string): string {
  const target = JSON.stringify(label);
  return `/* zenx-login:click */ (() => {
  const want = ${target};
  window.__zenxOpened = [];
  const original = window.open;
  window.open = (url) => { window.__zenxOpened.push(String(url)); return null; };
  setTimeout(() => { window.open = original; }, 5000);
  const wantedCjk = (String(want).match(/[\\u4e00-\\u9fff]+/g) || []);
  const groups = ["button", "a", "[role=button]", "li"];
  for (const selector of groups) {
    for (const node of document.querySelectorAll(selector)) {
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length === 0) continue;
      const own = text.match(/[\\u4e00-\\u9fff]+/g) || [];
      const hit = wantedCjk.length > 0
        ? wantedCjk.every((word) => own.some((candidate) => candidate.includes(word) || word.includes(candidate)))
        : text.includes(want);
      if (!hit) continue;
      const options = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
      for (const type of ["pointerover", "mouseover", "pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        node.dispatchEvent(new PointerEvent(type, options));
      }
      if (typeof node.click === "function") node.click();
      return { clicked: true, selector };
    }
  }
  return { clicked: false };
})()`;
}

const OAUTH_READ_EXPRESSION = `/* zenx-login:read */ (() => ({ urls: window.__zenxOpened || [] }))()`;

function oauthNavigateExpression(url: string): string {
  return `/* zenx-login:navigate */ (() => { location.href = ${JSON.stringify(url)}; return { navigating: true }; })()`;
}

/**
 * 只做"登录"这一步：不退出、不签到、不消耗额度之外的操作。
 *
 * 为什么需要它：checkin 的退出→重登一旦在重登阶段失败（站点限流、GitHub 会话过期、
 * 隐藏窗口），账号会停在登出态；而 checkin 的身份校验要求先处于正确登录态，于是
 * 它再也无法自救（只会 IDENTITY_MISMATCH）。这个命令把"登录"单独拆出来，用于恢复。
 *
 * 隔离窗口在返回前必定回收；失败也一样，不留窗口在桌面。
 */
export async function loginAccount(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 180_000,
  dependencies: LoginDependencies = {},
): Promise<LoginResult> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? delay;
  const deadline = now() + timeoutMs;
  const remaining = () => {
    const budget = Math.floor(deadline - now());
    if (budget < 1) throw new ZenxError("LOGIN_TIMEOUT", "登录总预算已耗尽；停止，不重试。", { alias });
    return budget;
  };
  return withStoreLock(home, async () => {
    const store = await readStore(home);
    const account = findAccount(store, alias);
    const base = { alias: account.alias, instanceId: account.instanceId, identity: account.expectedIdentity };

    const browsers = await listBrowsers(run, {
      timeoutMs: Math.min(60_000, remaining()),
      env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    const browser = browsers.find((item) => item.instance_id === account.instanceId);
    const connection: LoginResult["connection"] = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";
    if (connection !== "online") {
      return { ...base, ok: false, connection, alreadyLoggedIn: false, balance: null, code: connection.toUpperCase() };
    }

    const startReply = await run(
      ["session", "start", "--browser-id", account.instanceId, "--width", "1280", "--height", "800", "--json"],
      { timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" } },
    );
    remaining();
    if (startReply.exitCode !== 0) {
      throw new ZenxError("SESSION_START_FAILED", `session start 退出码 ${startReply.exitCode}；停止，不重试。`);
    }
    const sessionId = parseSessionStart(startReply.stdout);
    try {
      const sessionArgs = (...command: string[]) => [...command, "--session", sessionId];
      const call = async (command: string[]) => run(sessionArgs(...command), {
        timeoutMs: Math.min(60_000, remaining()),
        env: { BSK_BROWSER_WAIT_MS: "0" },
      });
      const readText = async () => {
        const reply = await call(["evaluate", "document.body.innerText.slice(0, 4000)", "--json"]);
        remaining();
        let value: unknown;
        try { value = JSON.parse(reply.stdout); }
        catch { throw new ZenxError("SITE_READ_FAILED", "页面求值返回无效 JSON；停止，不重试。"); }
        if (reply.exitCode !== 0 || !object(value) || value.ok !== true || typeof value.value !== "string") {
          throw new ZenxError("SITE_READ_FAILED", "无法读取页面正文；停止，不重试。");
        }
        if ([...value.value].length > TEXT_MAX_LENGTH) throw new ZenxError("SITE_READ_FAILED", "页面正文过长，拒绝解析；停止，不重试。");
        return value.value;
      };

      const navigate = await call(["navigate", siteUrl]);
      remaining();
      if (navigate.exitCode !== 0) throw new ZenxError("SITE_TIMEOUT", "导航到 AgentRouter 控制台失败；停止，不重试。");
      await sleep(PAGE_SETTLE_MS);
      remaining();

      let text = await readText();
      if (text.includes(account.expectedIdentity)) {
        return { ...base, ok: true, connection, alreadyLoggedIn: true, balance: extractBalance(text) };
      }
      const manual = detectManualIntervention(text);
      if (manual) {
        throw new ZenxError("MANUAL_INTERVENTION_REQUIRED", `检测到需要人工处理的页面特征（${manual}）；停止，请人工完成登录。`, { pageFeature: manual });
      }
      const limited = detectRateLimit(text);
      if (limited) {
        throw new ZenxError("LOGIN_RATE_LIMITED", `站点登录限流（${limited}）；不要连续重试，等待后再继续。`, { pageFeature: limited });
      }
      if (!LOGGED_OUT_PATTERNS.some((pattern) => text.includes(pattern))) {
        throw new ZenxError("LOGIN_PAGE_UNKNOWN", "页面既不是已登录状态也不是识别出的登录页；停止，不点击。");
      }

      // 输入通道：页面可见时走 bsk click（真实输入，window.open 能弹出授权窗口）；
      // 隐藏时走页面内 DOM 直调，并手动接管 window.open。
      const probe = await call(["evaluate", "(() => ({ visible: document.visibilityState === 'visible' }))()", "--json"]);
      remaining();
      let visible = false;
      try {
        const probeValue: unknown = JSON.parse(probe.stdout);
        if (object(probeValue) && probeValue.ok === true && object(probeValue.value) && probeValue.value.visible === true) visible = true;
      } catch { visible = false; }

      if (visible) {
        const observe = await call(["observe"]);
        remaining();
        if (observe.exitCode !== 0) throw new ZenxError("SESSION_OBSERVE_FAILED", "observe 失败；停止，不点击。");
        const match = /@(e\d+)\s+(?:button|link)\s+"[^"]*使用 GitHub 继续"/.exec(observe.stdout) ??
          /@(e\d+)\s+(?:button|link)\s+"[^"]*GitHub[^"]*"/.exec(observe.stdout);
        if (!match) throw new ZenxError("LOGIN_BUTTON_NOT_FOUND", "页面未找到 GitHub 登录按钮；停止，不点击。");
        const click = await call(["click", `@${match[1]}`]);
        remaining();
        if (click.exitCode !== 0) throw new ZenxError("SESSION_CLICK_FAILED", `点击登录按钮失败（退出码 ${click.exitCode}）；停止，不重试。`);
      } else {
        let clicked = false;
        // 中英文两套文案依次尝试：DOM 直调按子串命中，先中文后英文。
        for (const label of GITHUB_LOGIN_LABELS) {
          const dispatch = await call(["evaluate", domLoginClickExpression(label), "--json"]);
          remaining();
          try {
            const value: unknown = JSON.parse(dispatch.stdout);
            clicked = object(value) && value.ok === true && object(value.value) && value.value.clicked === true;
          } catch { clicked = false; }
          if (clicked) break;
        }
        if (!clicked) throw new ZenxError("LOGIN_BUTTON_NOT_FOUND", "未能在页面中找到 GitHub 登录按钮；停止，不点击。");
        await sleep(LOGIN_POLL_INTERVAL_MS);
        remaining();
        const capturedReply = await call(["evaluate", OAUTH_READ_EXPRESSION, "--json"]);
        remaining();
        let urls: string[] = [];
        try {
          const value: unknown = JSON.parse(capturedReply.stdout);
          if (object(value) && value.ok === true && object(value.value) && Array.isArray(value.value.urls)) {
            urls = value.value.urls.filter((item): item is string => typeof item === "string");
          }
        } catch { urls = []; }
        const oauthUrl = urls.find((item) => item.startsWith("https://github.com/"));
        if (oauthUrl) await call(["evaluate", oauthNavigateExpression(oauthUrl), "--json"]);
      }

      const loginDeadline = now() + LOGIN_POLL_BUDGET_MS;
      while (true) {
        await sleep(LOGIN_POLL_INTERVAL_MS);
        remaining();
        text = await readText();
        if (text.includes(account.expectedIdentity)) {
          return { ...base, ok: true, connection, alreadyLoggedIn: false, balance: extractBalance(text) };
        }
        const stuckManual = detectManualIntervention(text);
        if (stuckManual) {
          throw new ZenxError("MANUAL_INTERVENTION_REQUIRED", `检测到需要人工处理的页面特征（${stuckManual}）；停止，请人工完成登录。`, { pageFeature: stuckManual });
        }
        const nowLimited = detectRateLimit(text);
        if (nowLimited) {
          throw new ZenxError("LOGIN_RATE_LIMITED", `站点登录限流（${nowLimited}）；不要连续重试，等待后再继续。`, { pageFeature: nowLimited });
        }
        if (now() >= loginDeadline) {
          throw new ZenxError("LOGIN_TIMEOUT", `登录后 ${LOGIN_POLL_BUDGET_MS / 1000}s 内未完成；站点可能仍在限流，等待后再重试。`, { alias });
        }
      }
    } finally {
      // 无论成败必定回收 session，否则隔离窗口会残留在桌面上（也是内存占用的大头）。
      await run(["session", "stop", sessionId], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  });
}
