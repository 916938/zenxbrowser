/**
 * AnyRouter 批量签到：依次处理所有绑定了 AnyRouter 身份的账号。
 *
 * 刻意比 AgentRouter 的 checkin-batch 简单得多，因为两个站点的约束完全不同：
 * - **不消耗站点登录配额**（刷新页面即可，没有退出重登），因此不需要限流冷却与重试队列；
 * - **账号很少**（当前只有 2 个），因此不需要 --window 分组与内存窗口控制。
 *
 * 保留的只有两件事：离线按需拉起 Edge、单个失败不中断后续账号。
 */

import { readStore } from "./core.ts";
import type { Runner } from "./core.ts";
import { hasCreditedBetween, todayRange } from "./db.ts";
import { ensureOnline } from "./launch.ts";
import type { LaunchDependencies } from "./launch.ts";
import { anyrouterCheckin, ledgerAlias } from "./anyrouter-checkin.ts";

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
};

export type AnyRouterBatchReport = {
  ok: boolean;
  total: number;
  credited: number;
  skipped: number;
  failed: number;
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
};

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
  const store = await readStore(home);
  const targets = store.accounts.filter((account) => account.anyrouterIdentity);

  if (targets.length === 0) {
    progress("没有账号绑定 AnyRouter 身份；先用 accounts bind-anyrouter 绑定。");
    return { ok: true, total: 0, credited: 0, skipped: 0, failed: 0, accounts: [] };
  }

  const accounts: AnyRouterAccountOutcome[] = [];
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
          skipped: "already_credited_today", launched: false,
        });
        continue;
      }
    }

    try {
      const online = await ensureOnline(home, run, account.alias, options.timeoutMs ?? 45_000, options.launchDependencies);
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
      accounts.push({
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
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "COMMAND_FAILED";
      const message = error instanceof Error ? error.message : "签到失败。";
      progress(`${account.alias}: 失败（${code}: ${message}）`);
      accounts.push({
        alias: account.alias,
        identity,
        ok: false,
        code,
        message,
        balanceBefore: null,
        balanceAfter: null,
        credited: false,
        launched: false,
      });
      // 单个失败不中断后续账号。
    }
  }

  const credited = accounts.filter((item) => item.ok && item.credited).length;
  const skipped = accounts.filter((item) => item.skipped !== undefined).length;
  const failed = accounts.filter((item) => !item.ok).length;
  return { ok: failed === 0, total: accounts.length, credited, skipped, failed, accounts };
}
