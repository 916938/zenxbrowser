/**
 * AnyRouter 签到：刷新控制台页面即触发，无需退出重登。
 *
 * 与 AgentRouter 的关键差异：
 * - 签到在页面加载时自动完成，无签到按钮、无 toast 提示
 * - 无需退出重登、无公告弹窗
 * - 到账确认靠余额基线对比（与 recheck 同口径）
 */

import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { DEFAULT_DB_FILE, hasCreditedBetween, insertCheckin, insertSnapshot, lastBalancePointBefore, lastPairedSnapshotBefore, ledgerAliasOf } from "./db.ts";
import { anyRouter } from "./sites/anyrouter.ts";

export type AnyRouterCheckinDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  report?: (error: ZenxError) => void;
  dbFile?: string;
  /** 日界与观测时间；独立于超时预算的单调时钟。 */
  wallNow?: () => Date;
  /**
   * 忽略"今天已到账"的短路判断，强制执行一次刷新。
   * AnyRouter 的刷新不消耗登录配额（与 AgentRouter 的退出重登不同），
   * 重复执行是安全的，因此允许人工强制重跑。
   */
  force?: boolean;
};

const PAGE_SETTLE_MS = 3_000;
const NAVIGATE_ATTEMPTS = 3;
const NAVIGATE_RETRY_MS = 2_000;
const MAX_BASELINE_AGE_MS = 48 * 60 * 60_000;
const EVAL_TEXT_MAX_LENGTH = 20_000;

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
  catch { throw new ZenxError("EVAL_FAILED", "页面求值返回无效 JSON；停止，不重试。"); }
  if (!object(value) || value.ok !== true || typeof value.value !== "string") {
    throw new ZenxError("EVAL_FAILED", "无法读取页面正文；停止，不重试。");
  }
  if ([...value.value].length > EVAL_TEXT_MAX_LENGTH) {
    throw new ZenxError("EVAL_FAILED", "页面正文过长，拒绝解析；停止，不重试。");
  }
  return value.value;
}

/** 读到 0 一律当缺失：窗口隐藏时页面渲染不出余额（与 console.ts 同口径）。 */
function extractBalance(text: string): number | null {
  const value = anyRouter.parse.balance(text);
  return value !== null && value > 0 ? value : null;
}

function deadlineBudget(timeoutMs: number, deps: AnyRouterCheckinDependencies): () => number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ZenxError("INVALID_TIMEOUT", "签到预算必须是 1–300000 毫秒的整数。");
  }
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  return () => {
    const budget = Math.floor(deadline - now());
    if (budget < 1) throw new ZenxError("ANYROUTER_TIMEOUT", "签到总预算已耗尽；停止，不重试。");
    return budget;
  };
}

/** 本地"今天"对应的 UTC 区间 [start, end)。 */
function todayUtcRange(now: Date): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * AnyRouter 账本的 alias 后缀，与 AgentRouter 记录区分。
 *
 * 同一个 Edge Profile 在 AgentRouter 与 AnyRouter 上是两个不同的站点账号
 * （实测 edge-6：AgentRouter `github_206707`、AnyRouter `linuxdo_85789`），
 * 余额体系也完全独立（$1276 vs $5121）。不加后缀会让两者在账本与报表里
 * 混成一个账号，余额来回跳、当日到账凭空翻倍。
 */
export function ledgerAlias(alias: string): string {
  return ledgerAliasOf(alias, "anyrouter");
}

async function recordCheckin(
  account: Account,
  result: AnyRouterCheckinResult | null,
  error: unknown,
  dbFile?: string,
): Promise<void> {
  try {
    insertCheckin({
      time: result?.observedAt ?? new Date().toISOString(),
      alias: ledgerAlias(account.alias),
      instanceId: account.instanceId,
      identity: account.anyrouterIdentity ?? account.expectedIdentity,
      ok: result?.ok ?? false,
      balanceBefore: result?.balanceBefore ?? null,
      balanceAfter: result?.balanceAfter ?? null,
      credited: result?.checkinCredited ?? false,
      errorCode: result?.code ?? (error instanceof ZenxError ? error.code : error instanceof Error ? "COMMAND_FAILED" : null),
    }, dbFile ?? DEFAULT_DB_FILE);
  } catch {
    // 数据库写入失败不影响签到结果。
  }
}

export type AnyRouterCheckinResult = {
  ok: boolean;
  alias: string;
  instanceId: string;
  identity: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** 站点「历史消耗」累计值；读不到为 null。差分即真实消耗。 */
  totalSpent?: number | null;
  observedAt?: string;
  baselineTotalSpent?: number | null;
  balanceDelta?: number | null;
  spentDelta?: number | null;
  creditDelta?: number | null;
  checkinCredited: boolean;
  /** 当天已到账而跳过（不重复签到）。 */
  skipped?: "already_credited_today";
  code?: string;
};

/**
 * AnyRouter 签到：导航到控制台页面（这一步本身就是签到动作），
 * 核对登录身份，读余额确认到账。
 */
export async function anyrouterCheckin(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 60_000,
  dependencies: AnyRouterCheckinDependencies = {},
): Promise<AnyRouterCheckinResult> {
  const remaining = deadlineBudget(timeoutMs, dependencies);
  const sleep = dependencies.sleep ?? delay;
  return withStoreLock(home, async () => {
    const store = await readStore(home);
    const account = store.accounts.find((item) => item.alias === alias);
    if (!account) throw new ZenxError("ACCOUNT_NOT_FOUND", "账号别名尚未绑定；请先核对并绑定精确实例 ID。");
    if (!account.anyrouterIdentity) {
      throw new ZenxError("ANYROUTER_NOT_BOUND", `账号未绑定 AnyRouter 身份；请先运行 zenx accounts bind-anyrouter ${alias} --identity <站点用户名> --confirm。`);
    }

    // ① 前置检查：离线/错浏览器/协议不符直接返回，不启动 session。
    const browsers = await listBrowsers(run, {
      timeoutMs: Math.min(60_000, remaining()),
      env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    const browser = browsers.find((item) => item.instance_id === account.instanceId);
    const connection = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";
    if (connection !== "online") {
      const error = new ZenxError(connection.toUpperCase(), `账号未通过前置检查（${connection}）；未启动隔离窗口，不重试。`);
      await recordCheckin(account, null, error, dependencies.dbFile);
      return {
        ok: false, alias: account.alias, instanceId: account.instanceId,
        identity: account.anyrouterIdentity, balanceBefore: null, balanceAfter: null,
        checkinCredited: false, code: connection.toUpperCase(),
      };
    }

    // ② 今天已到账 → 跳过。AnyRouter 每日只发一次，重复刷新不会二次发放。
    // --force 可强制重跑：这里不像 AgentRouter 那样会白扣登录配额，刷新是幂等的。
    const { start, end } = todayUtcRange((dependencies.wallNow ?? (() => new Date()))());
    let creditedToday = false;
    if (dependencies.force !== true) {
      try { creditedToday = hasCreditedBetween(ledgerAlias(alias), start, end, dependencies.dbFile); }
      catch { creditedToday = false; }  // 账本读不了就照常签到，宁可多跑也不漏跑
    }
    if (creditedToday) {
      return {
        ok: true, alias: account.alias, instanceId: account.instanceId,
        identity: account.anyrouterIdentity, balanceBefore: null, balanceAfter: null,
        checkinCredited: true, skipped: "already_credited_today",
      };
    }

    // ③ 创建隔离窗口
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
      await recordCheckin(account, null, error, dependencies.dbFile);
      throw error;
    }

    const report = dependencies.report ?? ((error: ZenxError) => console.error(`${error.code}: ${error.message}`));
    let result: AnyRouterCheckinResult;
    try {
      result = await runAnyRouterSteps(run, sessionId, account, remaining, sleep, dependencies.dbFile, dependencies.wallNow);
      await recordCheckin(account, result, null, dependencies.dbFile);
    } catch (error) {
      await recordCheckin(account, null, error, dependencies.dbFile);
      throw error;
    } finally {
      // 无论成败必定回收 session，否则隔离窗口会残留在桌面上。
      try {
        const stopReply = await run(["session", "stop", sessionId], { timeoutMs: 30_000 });
        if (stopReply.exitCode !== 0) {
          report(new ZenxError("CLEANUP_INCOMPLETE", `签到隔离窗口可能未关闭（session stop 退出码 ${stopReply.exitCode}）；请手动关闭该 Edge 窗口。`));
        }
      } catch {
        report(new ZenxError("CLEANUP_INCOMPLETE", "签到隔离窗口可能未关闭（session stop 调用失败）；请手动关闭该 Edge 窗口。"));
      }
    }
    return result;
  });
}

async function runAnyRouterSteps(
  run: Runner,
  sessionId: string,
  account: Account,
  remaining: () => number,
  sleep: (ms: number) => Promise<void>,
  dbFile?: string,
  wallNow: () => Date = () => new Date(),
): Promise<AnyRouterCheckinResult> {
  const identity = account.anyrouterIdentity ?? "";

  // 导航到控制台：这一步就是签到动作（站点在页面加载时自动发放当日额度）。
  for (let attempt = 1; ; attempt++) {
    const reply = await run(["navigate", anyRouter.consoleUrl, "--session", sessionId], {
      timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    if (reply.exitCode === 0) break;
    if (attempt >= NAVIGATE_ATTEMPTS) {
      throw new ZenxError("SITE_TIMEOUT", `导航到 AnyRouter 控制台失败（${NAVIGATE_ATTEMPTS} 次尝试）；停止，不重试。`);
    }
    await sleep(NAVIGATE_RETRY_MS);
  }

  // 等待页面渲染（SPA，余额不是首屏就有）。
  await sleep(PAGE_SETTLE_MS);
  remaining();

  const evaluate = await run(["evaluate", "document.body.innerText.slice(0, 6000)", "--session", sessionId, "--json"], {
    timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" },
  });
  remaining();
  const text = parseEvaluate(evaluate.stdout);

  // 身份校验（红线）：页面身份与绑定身份不符立即停止，不记录任何结果。
  if (!text.includes(identity)) {
    throw new ZenxError("IDENTITY_MISMATCH", `控制台正文未包含预期的 AnyRouter 身份 ${identity}；立即停止。请核对绑定身份或该 Profile 当前登录的站点账号。`, { alias: account.alias });
  }

  const balanceAfter = extractBalance(text);
  const totalSpent = anyRouter.parse.totalSpent(text);

  const observed = wallNow();
  const observedAt = observed.toISOString();
  const { start } = todayUtcRange(observed);
  let baseline: number | null = null;
  let baselineTotalSpent: number | null = null;
  try {
    const alias = ledgerAlias(account.alias);
    const latest = lastBalancePointBefore(alias, start, dbFile);
    baseline = latest?.balance ?? null;
    const paired = lastPairedSnapshotBefore(alias, start, dbFile);
    // 不混配不同时点的消耗与余额，也不把陈旧观测窗口中的多日发放当成今天到账。
    if (paired && latest && paired.time === latest.time && paired.balance === latest.balance &&
        observed.getTime() - Date.parse(paired.time) <= MAX_BASELINE_AGE_MS) {
      baselineTotalSpent = paired.totalSpent;
    }
  } catch {
    // 保留已读到的余额；缺少配对读数时仅按余额差核对。
  }
  const balanceDelta = baseline !== null && balanceAfter !== null
    ? Math.round((balanceAfter - baseline) * 100) / 100 : null;
  const spentDelta = baselineTotalSpent !== null && totalSpent !== null && totalSpent >= baselineTotalSpent
    ? Math.round((totalSpent - baselineTotalSpent) * 100) / 100 : null;
  const creditDelta = balanceDelta === null ? null : Math.round((balanceDelta + (spentDelta ?? 0)) * 100) / 100;
  const checkinCredited = creditDelta !== null && creditDelta >= anyRouter.dailyCredit;

  // 先读取历史基线再写本轮观测；两张表共用观测时间，次日仍能严格配对。
  await recordObservation(account, balanceAfter, totalSpent, observedAt, dbFile);

  return {
    ok: true,
    alias: account.alias,
    instanceId: account.instanceId,
    identity,
    balanceBefore: baseline,
    balanceAfter,
    checkinCredited,
    totalSpent,
    observedAt,
    baselineTotalSpent,
    balanceDelta,
    spentDelta,
    creditDelta,
  };
}

/** 写入余额/消耗观测点。账本写入失败绝不能改变签到结果，因此对外静默。 */
async function recordObservation(
  account: Account,
  balance: number | null,
  totalSpent: number | null,
  observedAt: string,
  dbFile?: string,
): Promise<void> {
  try {
    insertSnapshot({
      time: observedAt,
      alias: ledgerAlias(account.alias),
      instanceId: account.instanceId,
      identity: account.anyrouterIdentity ?? account.expectedIdentity,
      balance,
      totalSpent,
      ok: true,
      errorCode: null,
    }, dbFile ?? DEFAULT_DB_FILE);
  } catch {
    // 忽略：观测点只是账本，写不进去不影响本次签到。
  }
}
