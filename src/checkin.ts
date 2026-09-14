import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { findAccount } from "./launch.ts";

export type CheckinDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const siteUrl = "https://agentrouter.org";
const SESSION_OBSERVE_MAX_LENGTH = 100_000;
const LOGIN_POLL_INTERVAL_MS = 2_000;
const LOGIN_POLL_BUDGET_MS = 60_000;
const ANNOUNCEMENT_SETTLE_MS = 1_500;
const PAGE_SETTLE_MS = 2_000;

/** GitHub 授权/验证页特征：出现任一即认为需要人工介入。 */
const MANUAL_INTERVENTION_PATTERNS = [
  "Sign in to GitHub",
  "Authorize",
  "Two-factor",
  "Verify",
  "device verification",
];

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

/** bsk observe（session 模式）的人读输出；取回整段正文用于状态判定。 */
function parseSessionObserve(stdout: string): SessionPage {
  if ([...stdout].length > SESSION_OBSERVE_MAX_LENGTH) {
    throw new ZenxError("SESSION_OBSERVE_INVALID", "observe 输出超长；停止，不重试。");
  }
  if (stdout.includes("error:")) {
    throw new ZenxError("SESSION_OBSERVE_INVALID", "observe 输出包含错误；停止，不重试。");
  }
  return { text: stdout };
}

/** 从 observe 输出中按 `@eN button "标签"` 提取目标按钮 ref。 */
export function findRefByLabel(page: SessionPage, label: string): string | undefined {
  const pattern = new RegExp(`@(e\\d+)\\s+(?:button|link|menuitem)\\s+"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  const match = pattern.exec(page.text);
  return match ? `@${match[1]}` : undefined;
}

function extractBalance(page: SessionPage): number | null {
  const match = /当前余额\s*\$([\d,]+(?:\.\d+)?)/.exec(page.text);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function hasAnnouncement(page: SessionPage): boolean {
  return page.text.includes("系统公告") && (page.text.includes("今日关闭") || page.text.includes("关闭公告"));
}

function isLoggedOut(page: SessionPage): boolean {
  return page.text.includes("注销成功") || (page.text.includes("登 录") && page.text.includes("使用 GitHub 继续"));
}

function needsManualIntervention(page: SessionPage): string | null {
  for (const pattern of MANUAL_INTERVENTION_PATTERNS) {
    if (page.text.includes(pattern)) return pattern;
  }
  return null;
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
      return { ok: false, alias: account.alias, instanceId: account.instanceId, connection, identity: "not_verified" };
    }

    // ② 启动隔离 session（--no-focus 不抢焦点）。
    const startReply = await run(
      ["session", "start", "--browser-id", account.instanceId, "--no-focus", "--json"],
      { timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" } },
    );
    remaining();
    if (startReply.exitCode !== 0) {
      throw new ZenxError("SESSION_START_FAILED", `session start 退出码 ${startReply.exitCode}；停止，不重试。`);
    }
    const sessionId = parseSessionStart(startReply.stdout);

    try {
      return await runCheckinSteps(run, sessionId, account, remaining, sleep, dependencies.now ?? (() => performance.now()));
    } finally {
      // 无论成败必定回收 session；stop 失败不掩盖原始错误。
      try {
        await run(["session", "stop", sessionId], { timeoutMs: 30_000 });
      } catch { /* stop 失败不覆盖原始错误 */ }
    }
  });
}

async function runCheckinSteps(
  run: Runner,
  sessionId: string,
  account: Account,
  remaining: () => number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
) {
  // ② 打开站点。
  const navigateReply = await runSessionCommand(run, sessionId, ["navigate", siteUrl], remaining);
  remaining();
  if (navigateReply.exitCode !== 0) {
    throw new ZenxError("SITE_TIMEOUT", "导航到 AgentRouter 失败；停止，不重试。");
  }
  await sleep(PAGE_SETTLE_MS);

  let page = await observePage(run, sessionId, remaining);

  // ③ 公告处理：动画时序兜底，两次点击内关闭。
  if (hasAnnouncement(page)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await sleep(ANNOUNCEMENT_SETTLE_MS);
      const closeRef = findRefByLabel(page, "关闭公告") ?? findRefByLabel(page, "今日关闭");
      if (!closeRef) throw new ZenxError("ANNOUNCEMENT_CLOSE_FAILED", "公告弹窗存在但未找到关闭按钮 ref；停止，不重试。");
      await clickRef(run, sessionId, closeRef, remaining);
      page = await observePage(run, sessionId, remaining);
      if (!hasAnnouncement(page)) break;
      if (attempt === 2) throw new ZenxError("ANNOUNCEMENT_CLOSE_FAILED", "两次点击后公告弹窗仍在；停止，不重试。");
    }
  }

  // ④ 身份验证（红线：不匹配立即停止）。
  if (!page.text.includes(account.expectedIdentity)) {
    throw new ZenxError("IDENTITY_MISMATCH", `observe 正文未包含预期身份 ${account.expectedIdentity}；立即停止，不执行退出。`);
  }

  // ⑤ 记录退出前余额。
  const balanceBefore = extractBalance(page);

  // ⑥ 退出：hover 用户菜单 → click 退出。
  const menuRef = new RegExp(`@(e\\d+)\\s+button\\s+"G\\s+${account.expectedIdentity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+chevron_down`).exec(page.text);
  if (!menuRef) throw new ZenxError("LOGOUT_FAILED", "未找到用户菜单按钮 ref；停止，不重试。");
  await hoverRef(run, sessionId, `@${menuRef[1]}`, remaining);
  page = await observePage(run, sessionId, remaining);
  const logoutRef = findRefByLabel(page, "exit 退出");
  if (!logoutRef) throw new ZenxError("LOGOUT_FAILED", "菜单展开后未找到退出项 ref；停止，不重试。");
  await clickRef(run, sessionId, logoutRef, remaining);
  page = await observePage(run, sessionId, remaining);
  if (!isLoggedOut(page)) throw new ZenxError("LOGOUT_FAILED", "点击退出后未见登录页；停止，不重试。");

  // ⑦ 重新登录：GitHub OAuth 轮询。
  const githubRef = findRefByLabel(page, "github_logo 使用 GitHub 继续");
  if (!githubRef) throw new ZenxError("LOGIN_TIMEOUT", "登录页未找到 GitHub 登录按钮 ref；停止，不重试。");
  await clickRef(run, sessionId, githubRef, remaining);

  const loginDeadline = now() + LOGIN_POLL_BUDGET_MS;
  let loggedIn = false;
  while (now() < loginDeadline) {
    await sleep(LOGIN_POLL_INTERVAL_MS);
    page = await observePage(run, sessionId, remaining);
    const manual = needsManualIntervention(page);
    if (manual) {
      throw new ZenxError("MANUAL_INTERVENTION_REQUIRED", `检测到需要人工处理的页面特征（${manual}）；停止，请人工完成登录后重试。`, { pageFeature: manual });
    }
    if (page.text.includes(account.expectedIdentity) && page.text.includes("当前余额")) { loggedIn = true; break; }
  }
  if (!loggedIn) throw new ZenxError("LOGIN_TIMEOUT", "重新登录轮询超时（60s）；停止，不重试。");

  // ⑧ 签到确认。
  const balanceAfter = extractBalance(page);
  const hasCheckinSuccess = page.text.includes("签到成功");
  const checkinCredited = (balanceBefore !== null && balanceAfter !== null && balanceAfter > balanceBefore) || hasCheckinSuccess;
  if (!checkinCredited) {
    return {
      ok: false,
      alias: account.alias,
      instanceId: account.instanceId,
      identity: account.expectedIdentity,
      balanceBefore,
      balanceAfter,
      checkinCredited: false,
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
