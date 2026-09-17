import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";
import { DEFAULT_DB_FILE, hasCreditedBetween, lastBalanceBefore } from "./db.ts";
import { readConsoleState } from "./console.ts";
import { findAccount } from "./launch.ts";

/** 站点每日签到发放的额度；余额相对基线的增量达到该值即认为当日已发放。 */
const DAILY_CREDIT = 25;

export type RecheckDependencies = {
  /** 返回 epoch 毫秒；同时用于超时预算与"今天"的日期边界。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 签到账本；默认项目根 zenxbrowser/checkin.db。 */
  dbFile?: string;
};

export type RecheckResult = {
  /** 是否已确认今日到账（决定 CLI 退出码：0=已到账，1=未到账或异常）。 */
  ok: boolean;
  alias: string;
  instanceId: string;
  identity: string;
  connection: "online" | "offline" | "wrong_browser" | "unsupported_protocol";
  login: "logged_in" | "logged_out" | "manual_intervention" | "unknown";
  identityMatch: boolean;
  balance: number | null;
  siteCheckedIn: boolean;
  /** 账本里今天是否已有"确认到账"记录。 */
  creditedToday: boolean;
  /** 账本里今天开始前该账号的最后一次已知余额（发放前基准）。 */
  baselineBalance: number | null;
  /** 当前余额相对基线的增量；任一端读不到时为 null。 */
  balanceDelta: number | null;
  verdict: "credited" | "not_credited" | "logged_out" | "manual_intervention" | "identity_mismatch" | "unknown";
  pageFeature?: string;
  note?: string;
};

/** 本地"今天"对应的 UTC 区间 [start, end)；按本地日界切，避免 UTC 日界把早上算到前一天。 */
export function todayUtcRange(now: Date): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function deadlineBudget(timeoutMs: number, now: () => number): () => number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ZenxError("INVALID_TIMEOUT", "复查预算必须是 1–300000 毫秒的整数。");
  }
  const deadline = now() + timeoutMs;
  return () => {
    const budget = Math.floor(deadline - now());
    if (budget < 1) throw new ZenxError("RECHECK_TIMEOUT", "复查总预算已耗尽；停止，不重试。");
    return budget;
  };
}

/**
 * 只读复查某账号"今日签到额度是否已到账"。
 *
 * 与 checkin 的区别：不退出、不重新登录、不消耗站点登录配额，只是在隔离窗口里
 * 读一次控制台，再结合账本给出结论。用于签到失败或"未确认"后的核对。
 *
 * 判定顺序（先红线后证据）：
 * 1. 未登录 / 需人工授权 → 无法核对，需人工登录后再看；
 * 2. 登录身份与绑定身份不符 → identity_mismatch（不允许据此判断任何额度）；
 * 3. 账本今日已有到账记录、站点显示已签到、或余额相对基线增长 ≥ 每日额度 → credited；
 * 4. 以上都没有 → not_credited（可重试签到；若当天早些时候登录过，额度可能已在
 *    那次发放，此时账本与余额都看不到增量，属"无法证明"而非"确认未发放"）。
 */
export async function recheckAccount(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 45_000,
  dependencies: RecheckDependencies = {},
): Promise<RecheckResult> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? delay;
  const remaining = deadlineBudget(timeoutMs, now);
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
    const connection: RecheckResult["connection"] = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";
    if (connection !== "online") {
      return {
        ...base, ok: false, connection, login: "unknown", identityMatch: false, balance: null,
        siteCheckedIn: false, creditedToday: false, baselineBalance: null, balanceDelta: null,
        verdict: "unknown", note: "实例离线或不兼容；未启动 Edge，未读取站点。先执行 ensure-online。",
      };
    }

    const state = await readConsoleState(run, account.instanceId, account.expectedIdentity, remaining, sleep);
    const { balance, siteCheckedIn } = state;

    // 账本侧：今日到账记录 + 今日开始前的余额基准。
    const { start, end } = todayUtcRange(new Date(now()));
    let creditedToday = false;
    let baselineBalance: number | null = null;
    try {
      creditedToday = hasCreditedBetween(account.alias, start, end, dependencies.dbFile ?? DEFAULT_DB_FILE);
      baselineBalance = lastBalanceBefore(account.alias, start, dependencies.dbFile ?? DEFAULT_DB_FILE);
    } catch {
      // 账本读不了不能影响站点读数：只让判据退化，不报错。
    }
    const balanceDelta = balance !== null && baselineBalance !== null ? Math.round((balance - baselineBalance) * 100) / 100 : null;

    if (state.login === "manual_intervention") {
      return {
        ...base, ok: false, connection, login: "manual_intervention", identityMatch: state.identityMatch,
        balance, siteCheckedIn, creditedToday, baselineBalance, balanceDelta,
        verdict: "manual_intervention", pageFeature: state.pageFeature,
        note: "检测到 GitHub 授权/验证页；需人工完成登录后重试。",
      };
    }
    if (state.login === "logged_out") {
      return {
        ...base, ok: false, connection, login: "logged_out", identityMatch: false,
        balance: null, siteCheckedIn: false, creditedToday, baselineBalance, balanceDelta: null,
        verdict: "logged_out",
        note: creditedToday
          ? "当前未登录；但账本显示今天已确认到账，额度应已发放，可人工登录后再跑 recheck 核对。"
          : "当前未登录；额度要在登录后才会发放，请先人工登录再签到。",
      };
    }
    if (!state.identityMatch) {
      return {
        ...base, ok: false, connection, login: "logged_in", identityMatch: false,
        balance, siteCheckedIn, creditedToday, baselineBalance, balanceDelta,
        verdict: "identity_mismatch",
        note: `控制台未出现预期身份 ${account.expectedIdentity}；不据此判断额度，请人工核对。`,
      };
    }

    const gained = balanceDelta !== null && balanceDelta >= DAILY_CREDIT;
    if (creditedToday || siteCheckedIn || gained) {
      const source = creditedToday ? "账本今日已有到账记录" : siteCheckedIn ? "站点显示今日已签到" : "余额相对基线已增长";
      return {
        ...base, ok: true, connection, login: "logged_in", identityMatch: true,
        balance, siteCheckedIn, creditedToday, baselineBalance, balanceDelta,
        verdict: "credited", note: `已确认今日到账（依据：${source}）。`,
      };
    }
    return {
      ...base, ok: false, connection, login: "logged_in", identityMatch: true,
      balance, siteCheckedIn, creditedToday, baselineBalance, balanceDelta,
      verdict: "not_credited",
      note: balanceDelta === null
        ? "未发现到账证据（缺少发放前余额基准，无法比较增量）；可重试签到，或次日再看余额趋势。"
        : "未发现到账证据：账本今日无到账记录、站点未显示已签到、余额也无增长。可重试签到。",
    };
  });
}
