/**
 * AnyRouter 批量签到：依次处理所有绑定了 AnyRouter 身份的账号。
 *
 * 刻意比 AgentRouter 的 checkin-batch 简单得多，因为两个站点的约束完全不同：
 * - **不消耗站点登录配额**（刷新页面即可，没有退出重登），因此不需要限流冷却与重试队列；
 * - **账号很少**（当前只有 2 个），因此不需要 --window 分组与内存窗口控制。
 *
 * 保留的只有三件事：离线按需拉起 Edge、单个失败不中断后续账号、只关自己拉起的实例
 * （`checkin-all --close-after` 会把这两个开关传下来）。
 */

import { readStore } from "./core.ts";
import type { Runner } from "./core.ts";
import { hasCreditedBetween, todayRange } from "./db.ts";
import { closeBrowser, ensureOnline } from "./launch.ts";
import type { LaunchDependencies } from "./launch.ts";
import { clearLaunchedInstance, recordLaunchedInstance } from "./leftover.ts";
import { anyrouterCheckin, ledgerAlias } from "./anyrouter-checkin.ts";

/** 关闭单个实例的预算：与 AgentRouter 批量收尾同一档。 */
const DEFAULT_CLOSE_TIMEOUT_MS = 45_000;

export type AnyRouterAccountOutcome = {
  alias: string;
  identity: string;
  ok: boolean;
  /** 错误码；成功或跳过时为 undefined。 */
  code?: string;
  message?: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** 站点「历史消耗」累计值。 */
  totalSpent?: number | null;
  balanceDelta?: number | null;
  spentDelta?: number | null;
  creditDelta?: number | null;
  credited: boolean;
  /** 当天已到账而跳过（未执行刷新，也未拉起 Edge 之外的动作）。 */
  skipped?: string;
  /** 该账号的 Edge 是否由本轮拉起（用户自己开着的为 false）。 */
  launched: boolean;
  /** 是否已关闭该实例释放内存（未开 --close-after 时为 false）。 */
  closed: boolean;
  closureError?: string;
};

export type AnyRouterBatchReport = {
  ok: boolean;
  total: number;
  credited: number;
  skipped: number;
  failed: number;
  /** 本轮实际释放（关闭）的实例数。 */
  released: number;
  accounts: AnyRouterAccountOutcome[];
};

export type AnyRouterBatchOptions = {
  /** 单账号签到预算（毫秒）。 */
  timeoutMs?: number;
  dbFile?: string;
  onProgress?: (line: string) => void;
  launchDependencies?: LaunchDependencies;
  /** 强制执行刷新，忽略"今天已到账"的短路判断。 */
  force?: boolean;
  /**
   * 释放内存：只关**本轮由 zenx 拉起**的实例。
   *
   * AnyRouter 的刷新不消耗登录配额，失败也不会把账号留在登出态，所以这里
   * 失败也照关——不像 AgentRouter 要留着窗口给人处理登出态。
   */
  closeAfter?: boolean;
  /** 单实例关闭预算（毫秒）。 */
  closeTimeoutMs?: number;
};

/** 释放单个账号占用的浏览器资源；失败只报告，不改变签到结论。 */
async function releaseInstance(
  home: string,
  run: Runner,
  alias: string,
  closeTimeoutMs: number,
  launchDependencies: LaunchDependencies | undefined,
  onProgress: (line: string) => void,
): Promise<{ closed: boolean; error?: string }> {
  try {
    const reply = await closeBrowser(home, run, alias, closeTimeoutMs, launchDependencies);
    // 只有复核确认离线才算释放：回包里的 closed 只是"请求已响应"。
    if (reply.outcome.instanceOffline) return { closed: true };
    return { closed: false, error: "关闭请求已响应，但复核时实例仍在注册表；未确认释放。" };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "COMMAND_FAILED";
    const message = error instanceof Error ? error.message : "关闭失败。";
    onProgress(`${alias}: 释放实例失败（${code}: ${message}）；可稍后用 zenx accounts close 或 close-leftover 处理。`);
    return { closed: false, error: `${code}: ${message}` };
  }
}

/**
 * 依次给所有绑定 AnyRouter 身份的账号签到。
 *
 * 只有绑定了 anyrouterIdentity 的账号才会被处理——没绑的直接跳过，不报错。
 * 这保证了将来给更多账号补绑 AnyRouter 身份时，本命令自动覆盖它们，
 * 而不用维护一份与 accounts.json 平行的别名清单（那正是 daily-checkin.ps1
 * 里 AgentRouter 名单的维护负担）。
 */
export async function anyrouterCheckinAll(
  home: string,
  run: Runner,
  options: AnyRouterBatchOptions = {},
): Promise<AnyRouterBatchReport> {
  const progress = options.onProgress ?? (() => undefined);
  const closeAfter = options.closeAfter === true;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const store = await readStore(home);
  const targets = store.accounts.filter((account) => account.anyrouterIdentity);

  if (targets.length === 0) {
    progress("没有账号绑定 AnyRouter 身份；先用 accounts bind-anyrouter 绑定。");
    return { ok: true, total: 0, credited: 0, skipped: 0, failed: 0, released: 0, accounts: [] };
  }

  /** 本轮由 zenx 拉起、尚未关闭的实例：只关这些，用户自己的 Edge 一律保留。 */
  const ours = new Set<string>();
  let released = 0;
  const accounts: AnyRouterAccountOutcome[] = [];
  /**
   * 收尾释放（--close-after）：只关本轮由 zenx 拉起的实例。
   *
   * 用户自己开着的 Edge 共用同一个 Profile，关掉会连标签页和未保存内容一起带走。
   * AnyRouter 的刷新失败也不会把账号留在登出态，所以失败同样照关，不留窗口。
   */
  const settle = async (outcome: AnyRouterAccountOutcome): Promise<void> => {
    const alias = outcome.alias;
    if (!closeAfter) return;
    if (!ours.has(alias)) {
      progress(`${alias}: 实例非本轮拉起（用户自己的 Edge），保留不关`);
      return;
    }
    const release = await releaseInstance(home, run, alias, closeTimeoutMs, options.launchDependencies, progress);
    outcome.closed = release.closed;
    outcome.closureError = release.error;
    if (release.closed) {
      released += 1;
      ours.delete(alias);
      // closeBrowser 已经清过追踪；再清一次兜住"关成功但追踪写盘失败"的残留。
      await clearLaunchedInstance(home, alias);
    }
  };
  const { start, end } = todayRange(new Date());
  for (const account of targets) {
    const identity = account.anyrouterIdentity ?? "";

    // 预判：今天已到账的账号连 Edge 都不拉起。单账号命令内部也有这道判断，
    // 但那已经是在 ensure-online 之后——批量场景下"为一个必然被跳过的账号
    // 拉起一个 Edge 进程"纯属浪费（AgentRouter 那 20 个号刚跑完，内存正紧）。
    if (options.force !== true) {
      let creditedToday = false;
      try { creditedToday = hasCreditedBetween(ledgerAlias(account.alias), start, end, options.dbFile); }
      catch { creditedToday = false; }  // 账本读不了就照常签到
      if (creditedToday) {
        progress(`${account.alias}: 今天已到账，跳过（${identity}）`);
        accounts.push({
          alias: account.alias, identity, ok: true,
          balanceBefore: null, balanceAfter: null, credited: true,
          skipped: "already_credited_today", launched: false, closed: false,
        });
        continue;
      }
    }

    try {
      const online = await ensureOnline(home, run, account.alias, options.timeoutMs ?? 45_000, options.launchDependencies);
      if (online.launched === true) {
        ours.add(account.alias);
        // 与 AgentRouter 同一套遗留追踪：拉起事实落盘，事后 close-leftover 才认得出。
        await recordLaunchedInstance(home, account.alias, online.instanceId);
      }
      const result = await anyrouterCheckin(home, run, account.alias, options.timeoutMs ?? 60_000, {
        dbFile: options.dbFile,
        force: options.force,
      });
      if (!result.ok) {
        progress(`${account.alias}: 失败（${result.code ?? "UNKNOWN"}）`);
      } else if (result.skipped !== undefined) {
        progress(`${account.alias}: 今天已到账，跳过（${identity}）`);
      } else if (result.checkinCredited) {
        progress(`${account.alias}: 已签到并确认到账（${identity}） ${result.balanceBefore} → ${result.balanceAfter}；到账增量 ${result.creditDelta?.toFixed(2) ?? "—"}`);
      } else {
        const reason = result.balanceBefore === null ? "缺少基线" : result.balanceAfter === null ? "未读到当前余额"
          : result.spentDelta == null ? `缺少可用的配对消耗，余额净变化 ${result.balanceDelta?.toFixed(2) ?? "—"}，不足以确认到账`
          : `余额与消耗合计增量 ${result.creditDelta?.toFixed(2) ?? "—"}，不足以确认到账`;
        progress(`${account.alias}: 已刷新（${identity}）余额 ${result.balanceAfter ?? "—"}；无法确认到账（${reason}）`);
      }
      const outcome: AnyRouterAccountOutcome = {
        alias: account.alias,
        identity,
        ok: result.ok,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        totalSpent: result.totalSpent,
        balanceDelta: result.balanceDelta,
        spentDelta: result.spentDelta,
        creditDelta: result.creditDelta,
        code: result.code,
        credited: result.checkinCredited,
        skipped: result.skipped,
        launched: online.launched,
        closed: false,
      };
      accounts.push(outcome);
      await settle(outcome);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "COMMAND_FAILED";
      const message = error instanceof Error ? error.message : "签到失败。";
      progress(`${account.alias}: 失败（${code}: ${message}）`);
      // ensure-online 拉起的实例也要释放：它已经占着一个 Edge 进程，停在哪一步都不影响这一点。
      const outcome: AnyRouterAccountOutcome = {
        alias: account.alias,
        identity,
        ok: false,
        code,
        message,
        balanceBefore: null,
        balanceAfter: null,
        credited: false,
        launched: ours.has(account.alias),
        closed: false,
      };
      accounts.push(outcome);
      await settle(outcome);
      // 单个失败不中断后续账号。
    }
  }

  const credited = accounts.filter((item) => item.ok && item.credited).length;
  const skipped = accounts.filter((item) => item.skipped !== undefined).length;
  const failed = accounts.filter((item) => !item.ok).length;
  return { ok: failed === 0, total: accounts.length, credited, skipped, failed, released, accounts };
}
