import { ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";

const siteUrl = "https://agentrouter.org/console";
const PAGE_SETTLE_MS = 2_000;
const SESSION_TEXT_MAX_LENGTH = 20_000;
/** 站点"今日已签到"状态特征；刻意不含"签到成功"（那是动作提示，不代表额度已发放）。 */
const ALREADY_CHECKED_IN_PATTERNS = ["已签到", "已打卡", "今日已签到", "今日已打卡", "checked in", "already checked in"];
const MANUAL_INTERVENTION_PATTERNS = ["Sign in to GitHub", "Authorize", "Two-factor", "Verify", "device verification"];

export type ConsoleState = {
  text: string;
  login: "logged_in" | "logged_out" | "manual_intervention";
  identityMatch: boolean;
  balance: number | null;
  /** 站点"历史消耗"累计值；这是做消耗对比的权威口径（差分即得区间消耗）。 */
  totalSpent: number | null;
  siteCheckedIn: boolean;
  pageFeature?: string;
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

function parseEvaluate(raw: string): string {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ZenxError("RECHECK_EVAL_FAILED", "页面求值返回无效 JSON；停止，不重试。"); }
  if (!object(value) || value.ok !== true || typeof value.value !== "string") {
    throw new ZenxError("RECHECK_EVAL_FAILED", "无法读取页面正文；停止，不重试。");
  }
  if ([...value.value].length > SESSION_TEXT_MAX_LENGTH) {
    throw new ZenxError("RECHECK_EVAL_FAILED", "页面正文过长，拒绝解析；停止，不重试。");
  }
  return value.value;
}

/** 控制台上的"当前余额 $X"。页面没渲染出来时返回 null（不算失败）。 */
export function extractBalance(text: string): number | null {
  const match = /当前余额\s*\$([\d,]+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * 控制台上的"历史消耗 $X"——站点累计消耗，不是区间消耗。
 * 两个时点的差值才是某段时间真实花掉的钱，用它对比比用余额差更可靠：
 * 余额同时被签到发放和消耗影响，缺口法会把"没签到"误算成"花多了"。
 */
export function extractTotalSpent(text: string): number | null {
  const match = /历史消耗\s*\$([\d,]+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function isLoggedOut(text: string): boolean {
  return text.includes("注销成功") || (text.includes("登 录") && text.includes("使用 GitHub 继续"));
}

/**
 * 在隔离窗口里读一次控制台（只读：不退出、不重登录、不点击）。
 * 隔离窗口在返回前必定回收；失败也一样，不留窗口在桌面。
 */
export async function readConsoleState(
  run: Runner,
  instanceId: string,
  expectedIdentity: string,
  remaining: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<ConsoleState> {
  const startReply = await run(
    ["session", "start", "--browser-id", instanceId, "--width", "1280", "--height", "800", "--json"],
    { timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" } },
  );
  remaining();
  if (startReply.exitCode !== 0) {
    throw new ZenxError("SESSION_START_FAILED", `session start 退出码 ${startReply.exitCode}；停止，不重试。`);
  }
  const sessionId = parseSessionStart(startReply.stdout);
  try {
    const navigate = await run(["navigate", siteUrl, "--session", sessionId], {
      timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    if (navigate.exitCode !== 0) throw new ZenxError("SITE_TIMEOUT", "导航到 AgentRouter 控制台失败；停止，不重试。");
    await sleep(PAGE_SETTLE_MS);
    remaining();
    const evaluate = await run(["evaluate", "document.body.innerText.slice(0, 4000)", "--json", "--session", sessionId], {
      timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    const text = parseEvaluate(evaluate.stdout);
    const manual = MANUAL_INTERVENTION_PATTERNS.find((pattern) => text.includes(pattern));
    const state: ConsoleState = {
      text,
      login: manual ? "manual_intervention" : isLoggedOut(text) ? "logged_out" : "logged_in",
      identityMatch: text.includes(expectedIdentity),
      balance: extractBalance(text),
      totalSpent: extractTotalSpent(text),
      siteCheckedIn: ALREADY_CHECKED_IN_PATTERNS.some((pattern) => text.toLowerCase().includes(pattern.toLowerCase())),
    };
    return manual ? { ...state, pageFeature: manual } : state;
  } finally {
    // 无论成败必定回收；固定预算且不依赖 remaining()：预算耗尽时 remaining() 本身会抛错。
    await run(["session", "stop", sessionId], { timeoutMs: 30_000 }).catch(() => undefined);
  }
}
