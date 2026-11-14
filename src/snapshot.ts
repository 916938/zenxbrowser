import { setTimeout as delay } from "node:timers/promises";
import { readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { DEFAULT_DB_FILE, insertSnapshot, lastBalancePointBefore, lastPairedSnapshotBefore, ledgerAliasOf, todayRange } from "./db.ts";
import type { SnapshotRecord } from "./db.ts";
import { readConsoleState } from "./console.ts";
import { findAccount } from "./launch.ts";
import type { LaunchDependencies } from "./launch.ts";
import { prepareOnline } from "./auto-online.ts";
import { agentRouter } from "./sites/agentrouter.ts";
import { anyRouter } from "./sites/anyrouter.ts";
import type { ReadableSite } from "./sites/readable.ts";

/**
 * 可采集快照的站点，以及"这个账号在该站点的身份"。
 *
 * 身份按站点取：同一个 Edge Profile 在两个站点上通常是两个不同的站点账号
 * （实测 edge-6：AgentRouter `github_206707`、AnyRouter `linuxdo_85789`），
 * 拿错身份会把正常页面判成 IDENTITY_MISMATCH。
 */
const SITES: { site: ReadableSite; identityOf: (account: Account) => string | undefined }[] = [
  { site: agentRouter, identityOf: (account) => account.expectedIdentity },
  { site: anyRouter, identityOf: (account) => account.anyrouterIdentity },
];

export type SnapshotDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 账本文件；默认项目根 zenxbrowser/checkin.db。 */
  dbFile?: string;
  /** 只采集这个站点（默认全部已绑定身份的站点）。 */
  siteId?: string;
  /** 实例离线时自动拉起已配置的 Edge Profile（默认 true）；false 保持纯只读。 */
  ensureOnline?: boolean;
  /** 保留自动拉起的 Edge（默认 false：采完只关自己拉起的实例，压住内存峰值）。 */
  keepOpen?: boolean;
  /** ensure-online / close 的依赖注入（测试替身）。 */
  launchDependencies?: LaunchDependencies;
  /** 进度输出；CLI 在非 --json 模式下传入。 */
  onProgress?: (line: string) => void;
  /** --missing --capture 判定「今天」用的时钟（测试注入）。 */
  at?: Date;
};

export type SnapshotResult = {
  ok: boolean;
  alias: string;
  instanceId: string;
  identity: string;
  /** 站点 id；账本里记在 ledgerAliasOf(alias, site) 下。 */
  site: string;
  connection: "online" | "offline" | "wrong_browser" | "unsupported_protocol";
  login: "logged_in" | "logged_out" | "manual_intervention" | "unknown";
  balance: number | null;
  totalSpent: number | null;
  errorCode?: string;
  note?: string;
  /** 该账号的 Edge 是否由本次快照自动拉起。 */
  launched?: boolean;
  /** 自动拉起的实例是否已复核确认关闭。 */
  closed?: boolean;
  closureError?: string;
  /** 自动拉起失败时的可执行下一步建议。 */
  hint?: string;
};

export type AutomaticSnapshotResult = {
  status: "saved" | "reused" | "incomplete" | "failed";
  time?: string;
  errorCode?: string;
  note?: string;
};

export function saveAutomaticSnapshot(record: SnapshotRecord, dbFile?: string): AutomaticSnapshotResult {
  const complete = record.ok && record.balance !== null && Number.isFinite(record.balance) && record.balance > 0 &&
    record.totalSpent !== null && Number.isFinite(record.totalSpent) && record.totalSpent >= 0;
  const errorCode = record.errorCode ?? (complete ? null : "SNAPSHOT_INCOMPLETE");
  try {
    insertSnapshot({ ...record, ok: complete, errorCode }, dbFile);
    return complete
      ? { status: "saved", time: record.time }
      : { status: "incomplete", time: record.time, errorCode: errorCode ?? "SNAPSHOT_INCOMPLETE", note: "未取得身份匹配的完整余额与累计消耗；未计为有效快照。" };
  } catch {
    return { status: "failed", errorCode: "SNAPSHOT_WRITE_FAILED", note: "自动快照写入失败；签到结果不受影响。" };
  }
}

export function existingDailySnapshot(alias: string, at: Date, dbFile?: string): AutomaticSnapshotResult | undefined {
  try {
    const { start, end } = todayRange(at);
    const latest = lastBalancePointBefore(alias, end, dbFile);
    const paired = lastPairedSnapshotBefore(alias, end, dbFile);
    if (paired && latest && paired.time >= start && paired.time === latest.time && paired.balance === latest.balance) {
      return { status: "reused", time: paired.time };
    }
  } catch {
    // 无法读取账本不应阻止签到，但不能声称已有有效快照。
  }
  return undefined;
}

export function dailySnapshotSummary(aliases: string[], at: Date, dbFile?: string) {
  const unique = [...new Set(aliases)];
  const missing = unique.filter((alias) => existingDailySnapshot(alias, at, dbFile) === undefined);
  return { ok: missing.length === 0, total: unique.length, saved: unique.length - missing.length, missing };
}

function deadlineBudget(timeoutMs: number, now: () => number): () => number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ZenxError("INVALID_TIMEOUT", "快照预算必须是 1–300000 毫秒的整数。");
  }
  const deadline = now() + timeoutMs;
  return () => {
    const budget = Math.floor(deadline - now());
    if (budget < 1) throw new ZenxError("SNAPSHOT_TIMEOUT", "快照总预算已耗尽；停止，不重试。");
    return budget;
  };
}

/**
 * 采集一次余额/消耗快照并写入账本。
 *
 * 目的：签到记录只在"签到那一刻"有余额，而账号平时被单独使用时两次签到之间
 * 花了多少完全看不见。每天落一个观测点（余额 + 站点累计消耗），周/月对比
 * 才有连续的消耗曲线。
 *
 * **按站点各采一次**：账号在哪些站点绑定了身份，就采哪些站点，各写一条
 * 独立记录（账本 alias 带站点后缀）。两个站点的余额体系完全独立，
 * 混成一条会让"当前余额"来回跳。
 *
 * **站点侧只读**：不退出、不重登、不消耗登录配额。失败也写一条（ok=false +
 * 错误码），保证"每天都试过"这件事在账本里有痕（与 checkin 的失败留痕口径一致）。
 *
 * 进程侧不是只读：实例离线时会按需拉起该账号已配置的 Edge Profile，采完只关
 * 这次自己拉起的实例（用户本来开着的 Edge 不动）。--ensure-online no 可退回
 * 完全纯只读，--keep-open 则保留自动拉起的窗口。
 */
export async function snapshotAccount(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 45_000,
  dependencies: SnapshotDependencies = {},
): Promise<SnapshotResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? delay;
  const dbFile = dependencies.dbFile ?? DEFAULT_DB_FILE;
  const auto = dependencies.ensureOnline ?? true;
  const progress = dependencies.onProgress ?? (() => undefined);

  // 只读预检：没绑定任何目标站点身份时连浏览器都不必碰。
  const preStore = await readStore(home);
  const preAccount = findAccount(preStore, alias);
  const wanted = SITES.some(({ site, identityOf }) =>
    (dependencies.siteId === undefined || dependencies.siteId === site.id) && identityOf(preAccount));
  if (!wanted) return [];

  // 连接判定 + 离线按需拉起。必须在 withStoreLock **之外**：ensureOnline 自己也持
  // 同一把账号锁，套在锁里会立刻 STORE_BUSY。拉起/回收/提示与 recheck 共用一份实现。
  const session = await prepareOnline(home, run, preAccount, {
    ensureOnline: auto,
    keepOpen: dependencies.keepOpen,
    launchDependencies: dependencies.launchDependencies,
    onProgress: progress,
    timeoutMs,
  });
  const connection = session.connection;

  let results: SnapshotResult[] = [];
  let release: { closed?: boolean; closureError?: string } = {};
  try {
    results = await withStoreLock(home, async () => {
      const store = await readStore(home);
      const account = findAccount(store, alias);
      // 只采"这个账号确实绑过身份"的站点；没绑的站点不是失败，跳过即可。
      const targets = SITES.filter(({ site, identityOf }) =>
        (dependencies.siteId === undefined || dependencies.siteId === site.id) && identityOf(account));

      const out: SnapshotResult[] = [];
      for (const { site, identityOf } of targets) {
        const identity = identityOf(account) ?? "";
        const base = { alias: account.alias, instanceId: account.instanceId, identity, site: site.id };
        // 每个站点一份独立预算：一个站点读超时不该把后面的站点也拖垮。
        const remaining = deadlineBudget(timeoutMs, now);
        let result: SnapshotResult;
        if (connection !== "online") {
          result = {
            ...base, ok: false, connection, login: "unknown", balance: null, totalSpent: null,
            errorCode: session.errorCode,
            note: session.note,
            ...(session.hint ? { hint: session.hint } : {}),
          };
        } else {
          try {
            const state = await readConsoleState(run, account.instanceId, identity, remaining, sleep, site);
            const failed = state.login === "manual_intervention"
              ? { errorCode: "MANUAL_INTERVENTION_REQUIRED", note: "检测到需人工处理的授权/验证页；需人工登录。" }
              : state.login === "logged_out"
                ? { errorCode: "LOGGED_OUT", note: "当前未登录；读不到该账号的余额与消耗。" }
                : !state.identityMatch
                  ? { errorCode: "IDENTITY_MISMATCH", note: `控制台未出现预期身份 ${identity}。` }
                  : undefined;
            // 页面隐藏（窗口被遮挡/后台）时控制台往往不渲染余额与消耗，正文里读不到。
            // 这不是失败，但这条快照没有观测价值，要明确提示，避免"有记录却全是空"被当成正常。
            const note = failed?.note ?? (state.balance === null || state.totalSpent === null
              ? "已记录，但页面未渲染出余额/消耗：窗口可能处于隐藏状态。激活该 Edge 窗口后重采一次才有效。"
              : "已记录余额与累计消耗。");
            result = {
              ...base, ok: failed === undefined, connection, login: state.login,
              balance: state.balance, totalSpent: state.totalSpent,
              ...(failed ?? { note }),
            };
          } catch (error) {
            // 单个站点读失败不影响其他站点，但要如实留痕。
            result = {
              ...base, ok: false, connection, login: "unknown", balance: null, totalSpent: null,
              errorCode: error instanceof ZenxError ? error.code : "COMMAND_FAILED",
              note: error instanceof Error ? error.message : "采集失败。",
            };
          }
        }

        insertSnapshot({
          time: new Date(now()).toISOString(),
          alias: ledgerAliasOf(result.alias, site.id),
          instanceId: result.instanceId,
          identity: result.identity,
          balance: result.balance,
          totalSpent: result.totalSpent,
          ok: result.ok,
          errorCode: result.errorCode ?? null,
        }, dbFile);
        out.push(result);
      }
      return out;
    });
  } finally {
    // 批量是串行的：采完立刻关掉本次拉起的实例，内存峰值始终只有一个 Profile。
    // 用户自己开着的 Edge（launched=false）一律保留，不碰其标签页。
    release = await session.finish();
  }
  return results.map((item) => ({ ...item, launched: session.launched, ...release }));
}

/** 批量采集：逐个账号执行，单个失败不中断后续账号。 */
export async function snapshotAll(
  home: string,
  run: Runner,
  timeoutMs: number = 45_000,
  dependencies: SnapshotDependencies = {},
): Promise<{ ok: boolean; total: number; saved: number; results: SnapshotResult[] }> {
  const store = await readStore(home);
  const results: SnapshotResult[] = [];
  for (const account of store.accounts) {
    try {
      results.push(...await snapshotAccount(home, run, account.alias, timeoutMs, dependencies));
    } catch (error) {
      results.push({
        ok: false,
        alias: account.alias,
        instanceId: account.instanceId,
        identity: account.expectedIdentity,
        site: agentRouter.id,
        connection: "offline",
        login: "unknown",
        balance: null,
        totalSpent: null,
        errorCode: error instanceof ZenxError ? error.code : "COMMAND_FAILED",
        note: error instanceof Error ? error.message : "采集失败。",
      });
    }
  }
  const saved = results.filter((item) => item.ok).length;
  return { ok: results.length > 0 && saved === results.length, total: results.length, saved, results };
}

/**
 * 一键补采（`snapshot --missing --capture`）：把 today 还缺配对快照的账号
 * 一次性补齐，离线自动拉起、采完只关自己拉起的实例。
 *
 * 与 --all 的区别：已经有有效快照的账号连 bsk 都不碰，更不会为它拉起 Edge。
 * 日常只该跑这一条；--all 是"强制全量重采"，会为二十个账号各拉起一次浏览器。
 */
export async function snapshotMissing(
  home: string,
  run: Runner,
  timeoutMs: number = 45_000,
  dependencies: SnapshotDependencies = {},
): Promise<{ ok: boolean; total: number; saved: number; missing: string[]; failed: string[]; results: SnapshotResult[] }> {
  const at = dependencies.at ?? new Date();
  const store = await readStore(home);
  const summary = dailySnapshotSummary(store.accounts.map((item) => item.alias), at, dependencies.dbFile);
  const progress = dependencies.onProgress ?? (() => undefined);
  if (summary.missing.length === 0) {
    progress("今天每个账号都已有配对快照，无需补采；未拉起任何 Edge。");
    return { ok: true, total: 0, saved: 0, missing: [], failed: [], results: [] };
  }

  const results: SnapshotResult[] = [];
  for (const alias of summary.missing) {
    try {
      results.push(...await snapshotAccount(home, run, alias, timeoutMs, dependencies));
    } catch (error) {
      const account = store.accounts.find((item) => item.alias === alias);
      results.push({
        ok: false,
        alias,
        instanceId: account?.instanceId ?? "",
        identity: account?.expectedIdentity ?? "",
        site: agentRouter.id,
        connection: "offline",
        login: "unknown",
        balance: null,
        totalSpent: null,
        errorCode: error instanceof ZenxError ? error.code : "COMMAND_FAILED",
        note: error instanceof Error ? error.message : "采集失败。",
      });
    }
  }
  const failed = summary.missing.filter((alias) => {
    const rows = results.filter((item) => item.alias === alias);
    return rows.length === 0 || rows.some((item) => !item.ok);
  });
  const saved = results.filter((item) => item.ok).length;
  progress(`补采完成：${summary.missing.length} 个缺快照账号，写入 ${saved} 条有效记录，仍未补齐 ${failed.length} 个${failed.length ? `（${failed.join(", ")}）` : ""}`);
  return { ok: failed.length === 0, total: results.length, saved, missing: summary.missing, failed, results };
}
