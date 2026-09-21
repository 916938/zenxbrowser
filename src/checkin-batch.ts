import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readStore, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { creditedTodayAliases } from "./db.ts";
import type { LaunchDependencies } from "./launch.ts";
import { checkinAccount } from "./checkin.ts";
import type { CheckinResult } from "./checkin.ts";
import { closeBrowser, ensureOnline } from "./launch.ts";

/**
 * 站点登录限流后的默认冷却时间。站点约 10 分钟恢复，脚本取 15 分钟留余量。
 * 关键是：限流不是账号级的，而是**站点侧的共享配额**——同一出口 IP 连续登录若干次后，
 * 站点对所有账号都只提示"登录次数过多请稍后再试"，此时继续跑只会把更多账号退出成登出态。
 */
export const DEFAULT_RETRY_WAIT_MS = 15 * 60_000;
/** 默认视为"可能是限流、值得冷却后重试"的错误码。 */
export const DEFAULT_RETRY_CODES = ["LOGIN_RATE_LIMITED", "LOGIN_TIMEOUT"];

const STATE_VERSION = 1;
const DEFAULT_CLOSE_TIMEOUT_MS = 45_000;

export type BatchAccountState = {
  lastAttempt: string;
  lastResult: "credited" | "skipped" | "rate_limited" | "failed" | "closed";
  lastCode: string | null;
  attempts: number;
  balanceAfter: number | null;
  credited: boolean;
};

export type BatchState = {
  version: typeof STATE_VERSION;
  updatedAt: string;
  accounts: Record<string, BatchAccountState>;
};

export type AccountOutcome = {
  alias: string;
  ok: boolean;
  /** 错误码；成功或跳过时为 undefined。 */
  code?: string;
  message?: string;
  credited: boolean;
  skipped?: string;
  attempts: number;
  /** 命中限流（已排入冷却重试队列）。 */
  rateLimited: boolean;
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** 签到成功后是否已关闭该实例释放内存（未开 --close-after 时为 false）。 */
  closed: boolean;
  closureError?: string;
  /** 该账号的 Edge 是否由本轮拉起；false 表示它本来就在跑（用户自己的）。 */
  launched?: boolean;
};

export type CheckinBatchReport = {
  ok: boolean;
  total: number;
  credited: number;
  failed: number;
  /** 轮次：各组累计的尝试批次（限流冷却后进入下一轮）。 */
  rounds: number;
  waitedMs: number;
  /** 同时在线的账号上限；0 表示不分组。 */
  windowSize: number;
  /** 分了几组。 */
  groups: number;
  /** 本轮实际释放（关闭）的实例数。 */
  released: number;
  /** 开跑前就因"今天已到账"被跳过的账号数（这些账号没有拉起 Edge）。 */
  skippedAlreadyCredited: number;
  accounts: AccountOutcome[];
  stateFile: string;
};

/**
 * 签到前的预判结果：今天还要签哪些、哪些已经签过了。
 *
 * 只读账本，不碰 bsk、不拉起任何 Edge——这是它存在的意义：批量签到最贵的资源
 * 是 Edge 实例（每个 Profile 一个常驻进程），能在拉起之前就排除掉的账号，
 * 就不要为它花一个进程和一次登录配额。
 */
export type PendingCheckinsReport = {
  ok: true;
  /** 本地日期（YYYY-MM-DD），与报表分天口径一致。 */
  date: string;
  /** 今天还没有到账记录的账号。 */
  pending: string[];
  /** 今天已确认到账的账号。 */
  done: string[];
};

/**
 * 列出"今天还没到账"的账号，供签到总命令与日常脚本在执行前筛选。
 * 账本读不了时全部算作待签到——宁可多跑，也不能漏跑。
 */
export async function pendingCheckins(
  home: string,
  options: { dbFile?: string; now?: () => Date } = {},
): Promise<PendingCheckinsReport> {
  const at = (options.now ?? (() => new Date()))();
  const store = await readStore(home);
  const credited = creditedTodayAliases(at, options.dbFile);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    ok: true,
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    pending: store.accounts.map((account) => account.alias).filter((alias) => !credited.has(alias)),
    done: store.accounts.map((account) => account.alias).filter((alias) => credited.has(alias)),
  };
}

export type CheckinBatchOptions = {
  /** 限定账号；缺省为 store 里的全部账号。 */
  aliases?: string[];
  checkinTimeoutMs?: number;
  ensureTimeoutMs?: number;
  /** 限流冷却时长；默认 15 分钟。 */
  waitMs?: number;
  /** 每个账号最多自动重试几次；默认 1。 */
  maxRetries?: number;
  /** 哪些错误码算限流；默认 LOGIN_RATE_LIMITED 与 LOGIN_TIMEOUT。 */
  retryCodes?: string[];
  /**
   * 签到成功后立即关闭该 Edge 实例，释放内存。
   *
   * 只关**本轮由 zenx 拉起**的实例：你自己开着的 Edge 共用同一个 Profile，
   * 关掉它会连标签页和未保存内容一起带走。
   */
  closeAfter?: boolean;
  /** ensure-online 的依赖注入（测试替身）。 */
  launchDependencies?: LaunchDependencies;
  /** 同时在线的账号上限（默认 8）：一组签完就关掉再拉下一组，压住内存峰值；0 表示不分组。 */
  windowSize?: number;
  force?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 批量状态文件；默认 .zenx/checkin-state.json。 */
  stateFile?: string;
  dbFile?: string;
  onProgress?: (line: string) => void;
};

function stateFileFor(home: string, explicit?: string): string {
  return explicit ?? join(home, "checkin-state.json");
}

export async function readState(file: string): Promise<BatchState> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch { return { version: STATE_VERSION, updatedAt: "", accounts: {} }; }
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Partial<BatchState>;
    if (record.version !== STATE_VERSION || record.accounts === null || typeof record.accounts !== "object") throw new Error();
    return { version: STATE_VERSION, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "", accounts: record.accounts as BatchState["accounts"] };
  } catch {
    // 状态文件只用于追踪，损坏不该让签到跑不起来。
    return { version: STATE_VERSION, updatedAt: "", accounts: {} };
  }
}

export async function writeState(file: string, state: BatchState): Promise<void> {
  const payload = { ...state, updatedAt: new Date().toISOString() };
  const temp = join(dirname(file), `.checkin-state-${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } catch {
    // 状态写失败不影响签到结果。
  } finally {
    await rm(temp, { force: true });
  }
}

/** 释放单个账号占用的浏览器资源；失败只报告，不改变签到结论。 */
async function releaseInstance(
  home: string,
  run: Runner,
  alias: string,
  onProgress: (line: string) => void,
): Promise<{ closed: boolean; error?: string }> {
  try {
    const reply = await closeBrowser(home, run, alias, DEFAULT_CLOSE_TIMEOUT_MS);
    if (reply.disconnected) return { closed: true };
    return { closed: false, error: "实例仍处于连接状态；未关闭。" };
  } catch (error) {
    const message = error instanceof ZenxError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "关闭失败。";
    onProgress(`${alias}: 释放实例失败（${message}）；可稍后用 zenx accounts close 处理。`);
    return { closed: false, error: message };
  }
}

/**
 * 同时在线（同时占用 Edge 实例）的账号上限。默认 8：二十个 Edge Profile 一起常驻
 * 是本机最大的内存开销，签完一批就关一批比"全部拉起再逐个关"稳得多。
 * 设为 0 表示不分组（一次性跑完再统一收尾）。
 */
export const DEFAULT_WINDOW_SIZE = 8;

/** 冷却进度输出间隔：长等待中途报一次剩余，免得看起来像卡死。 */
const COOLDOWN_PROGRESS_STEP_MS = 5 * 60_000;

function stamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 分段等待，每段结束报告剩余时长。
 * 分段而不是一次 sleep：15 分钟没有任何输出时无法区分"在等冷却"和"卡住了"。
 * 不足一整段时就是单次 sleep，行为与原来一致。
 */
async function sleepWithProgress(
  waitMs: number,
  sleep: (ms: number) => Promise<void>,
  onProgress: (line: string) => void,
): Promise<void> {
  let waited = 0;
  while (waited < waitMs) {
    const step = Math.min(COOLDOWN_PROGRESS_STEP_MS, waitMs - waited);
    await sleep(step);
    waited += step;
    const leftMs = waitMs - waited;
    if (leftMs > 0) onProgress(`冷却中：剩余 ${Math.ceil(leftMs / 60_000)} 分钟`);
  }
}

function chunkAccounts(accounts: Account[], size: number): Account[][] {
  const groups: Account[][] = [];
  for (let index = 0; index < accounts.length; index += size) groups.push(accounts.slice(index, index + size));
  return groups;
}

/**
 * 批量签到：按窗口分组处理账号，并在站点限流时自动冷却重试。
 *
 * 三个关键点区别于"for 循环 + 每个账号重试"：
 * 1. 限流是站点侧的共享配额，一旦命中就**停止本轮剩余账号**（否则会把更多账号退出成登出态，
 *    而登出态连 checkin 都无法再启动，只能靠 zenx accounts login 恢复）；
 * 2. **窗口上限**（默认 8）：一次只让这么多账号在线，一组签完立刻关掉它们的 Edge 实例，
 *    再拉起下一组——内存占用的峰值因此被压在窗口大小的实例数上；
 * 3. 冷却等待期间已完成账号保持关闭状态，不会白占 15 分钟内存。
 */
export async function checkinAll(home: string, run: Runner, options: CheckinBatchOptions = {}): Promise<CheckinBatchReport> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? delay;
  const waitMs = options.waitMs ?? DEFAULT_RETRY_WAIT_MS;
  const maxRetries = options.maxRetries ?? 1;
  const retryCodes = new Set(options.retryCodes ?? DEFAULT_RETRY_CODES);
  const closeAfter = options.closeAfter === true;
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const onProgress = options.onProgress ?? (() => undefined);
  const file = stateFileFor(home, options.stateFile);
  const outcomes = new Map<string, AccountOutcome>();
  const state = await readState(file);

  const store = await readStore(home);
  const wanted = options.aliases && options.aliases.length > 0
    ? options.aliases.map((alias) => {
      const account = store.accounts.find((item) => item.alias === alias);
      if (!account) throw new ZenxError("ACCOUNT_NOT_FOUND", `账号别名 ${alias} 尚未绑定；请先核对 accounts.json。`);
      return account;
    })
    : [...store.accounts];

  // 开跑前先按账本预判：今天已到账的账号直接跳过，**连 Edge 都不拉起**。
  // 站点每日只发一次额度，重复签到拿不到钱，却要白花一次登录配额和一个常驻
  // Edge 进程——实例是这一轮最贵的资源。这也是续跑中断批次时不至于从头重来的原因。
  const preCredited = options.force === true
    ? new Set<string>()
    : creditedTodayAliases(new Date(now()), options.dbFile);
  const todo: Account[] = [];
  for (const account of wanted) {
    if (preCredited.has(account.alias)) {
      outcomes.set(account.alias, {
        alias: account.alias,
        ok: true,
        credited: true,
        skipped: "already_credited_today",
        attempts: 0,
        rateLimited: false,
        balanceBefore: null,
        balanceAfter: null,
        closed: false,
      });
      onProgress(`${account.alias}: 跳过（账本显示今天已到账，不拉起 Edge）`);
      continue;
    }
    todo.push(account);
  }

  const groups = windowSize > 0 ? chunkAccounts(todo, windowSize) : [todo];
  let rounds = 0;
  let waited = 0;
  let released = 0;

  const remember = async (alias: string, outcome: AccountOutcome) => {
    outcomes.set(alias, outcome);
    state.accounts[alias] = {
      lastAttempt: new Date(now()).toISOString(),
      lastResult: outcome.ok ? (outcome.credited ? "credited" : "skipped") : outcome.rateLimited ? "rate_limited" : "failed",
      lastCode: outcome.code ?? null,
      attempts: outcome.attempts,
      balanceAfter: outcome.balanceAfter,
      credited: outcome.credited,
    };
    // 每次都落盘：批量跑可能被中断，状态文件要能反映最后一次真实结果。
    await writeState(file, state);
  };

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (groups.length > 1) {
      onProgress(`[组 ${groupIndex + 1}/${groups.length}] ${group.length} 个账号（同时在线上限 ${windowSize}）`);
    }
    let pending: Account[] = group;
    let round = 0;

    while (pending.length > 0) {
      round += 1;
      rounds += 1;
      const deferred: Account[] = [];
      for (let index = 0; index < pending.length; index++) {
        const account = pending[index];
        const attempt = (outcomes.get(account.alias)?.attempts ?? 0) + 1;
        onProgress(`[轮 ${round}] ${account.alias}: 第 ${attempt} 次签到`);
        const outcome = await runOne(home, run, account, { ...options, attempt, closeAfter, onProgress, now, sleep });
        await remember(account.alias, outcome);
        if (outcome.ok) {
          onProgress(`${account.alias}: ${outcome.skipped ? `跳过（${outcome.skipped}）` : `已到账 ${outcome.balanceBefore} → ${outcome.balanceAfter}`}`);
          continue;
        }
        onProgress(`${account.alias}: 失败 ${outcome.code ?? "UNKNOWN"} — ${outcome.message ?? ""}`);
        if (outcome.rateLimited) {
          // 本轮剩下的账号同样会命中共享配额，一并推迟到冷却之后再试。
          deferred.push(...pending.slice(index));
          // 带上时间戳与错误码：限流是整轮最耗时的一步，事后排查全靠这几行。
          onProgress(
            `[${stamp(now())}] 命中站点登录限流（${outcome.code ?? "UNKNOWN"}，账号 ${account.alias}）：` +
              `剩余 ${deferred.length} 个账号推迟到冷却后重试`,
          );
          break;
        }
      }
      if (deferred.length === 0 || round > maxRetries) break;
      const coolStart = now();
      const coolEnd = coolStart + waitMs;
      onProgress(
        `[${stamp(coolStart)}] 冷却开始：${Math.round(waitMs / 60_000)} 分钟（${stamp(coolEnd)} 结束），` +
          `随后重试 ${deferred.length} 个账号：${deferred.map((item) => item.alias).join(", ")}`,
      );
      await sleepWithProgress(waitMs, sleep, onProgress);
      waited += waitMs;
      onProgress(`[${stamp(now())}] 冷却结束，开始重试 ${deferred.length} 个账号`);
      pending = deferred;
    }

    // 这一组结束就释放它们的 Edge 实例：内存峰值 = 窗口大小，而不是账号总数。
    // 在窗口内失败也要关——失败的账号同样占着一个 Edge 进程（它停在哪一步都不影响这一点）。
    if (closeAfter || windowSize > 0) {
      for (const account of group) {
        const current = outcomes.get(account.alias);
        if (current?.closed) continue;
        // 只关本轮拉起的实例。本来就在跑的那个 Edge 是用户自己的（共用同一 Profile），
        // 关掉会连标签页和未保存内容一起带走——省内存远不值得冒这个险。
        if (current?.launched === false) {
          onProgress(`${account.alias}: 实例非本轮拉起（用户自己的 Edge），保留不关`);
          continue;
        }
        const release = await releaseInstance(home, run, account.alias, onProgress);
        if (release.closed) released += 1;
        await remember(account.alias, {
          ...(current ?? {
            alias: account.alias,
            ok: false,
            code: "NOT_ATTEMPTED",
            message: "本轮未尝试。",
            credited: false,
            attempts: 0,
            rateLimited: false,
            balanceBefore: null,
            balanceAfter: null,
            closed: false,
          }),
          closed: release.closed,
          closureError: release.error,
        });
        if (release.closed) {
          state.accounts[account.alias] = { ...state.accounts[account.alias], lastResult: "closed" };
          await writeState(file, state);
        }
      }
    }
  }

  const accounts = wanted.map((account) => outcomes.get(account.alias) ?? {
    alias: account.alias,
    ok: false,
    code: "NOT_ATTEMPTED",
    message: "本轮未尝试（前序账号限流推迟后超出重试上限）。",
    credited: false,
    attempts: 0,
    rateLimited: false,
    balanceBefore: null,
    balanceAfter: null,
    closed: false,
  });
  const failed = accounts.filter((item) => !item.ok).length;
  return {
    ok: failed === 0,
    total: accounts.length,
    credited: accounts.filter((item) => item.credited).length,
    failed,
    rounds,
    waitedMs: waited,
    /** 同时在线上限；0 表示不分组。 */
    windowSize,
    groups: groups.length,
    /** 本轮实际关闭的实例数（释放内存）。 */
    released,
    /** 开跑前就因"今天已到账"跳过、未拉起 Edge 的账号数。 */
    skippedAlreadyCredited: accounts.filter((item) => item.skipped === "already_credited_today" && item.attempts === 0).length,
    accounts,
    stateFile: file,
  };
}

async function runOne(
  home: string,
  run: Runner,
  account: Account,
  context: {
    attempt: number;
    closeAfter: boolean;
    onProgress: (line: string) => void;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    checkinTimeoutMs?: number;
    ensureTimeoutMs?: number;
    force?: boolean;
    retryCodes?: string[];
    maxRetries?: number;
    dbFile?: string;
    launchDependencies?: LaunchDependencies;
  },
): Promise<AccountOutcome> {
  const retryCodes = new Set(context.retryCodes ?? DEFAULT_RETRY_CODES);
  const maxRetries = context.maxRetries ?? 1;
  const base = {
    alias: account.alias,
    attempts: context.attempt,
    rateLimited: false,
    balanceBefore: null,
    balanceAfter: null,
    closed: false,
    credited: false,
    launched: false,
  };
  let launched = false;
  try {
    const online = await ensureOnline(home, run, account.alias, context.ensureTimeoutMs ?? 60_000, context.launchDependencies);
    launched = online.launched === true;
  } catch (error) {
    return {
      ...base,
      ok: false,
      code: error instanceof ZenxError ? error.code : "COMMAND_FAILED",
      message: error instanceof Error ? error.message : "无法拉起 Edge。",
    };
  }
  try {
    const result: CheckinResult = await checkinAccount(home, run, account.alias, context.checkinTimeoutMs ?? 180_000, {
      force: context.force === true,
      dbFile: context.dbFile,
      now: context.now,
      sleep: context.sleep,
      // 只关本轮拉起的实例：账号本来就在线时，那个 Edge 是用户自己的，
      // 共用同一个 Profile —— 关掉会连标签页与未保存内容一起带走。
      closeAfter: context.closeAfter && launched === true,
    });
    return {
      ...base,
      launched,
      ok: result.ok,
      credited: result.checkinCredited === true && result.skipped === undefined,
      skipped: result.skipped,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      code: result.code,
      message: result.code === "CHECKIN_UNCONFIRMED" ? "流程跑完但未确认到账；用 zenx accounts recheck 核对。" : undefined,
    };
  } catch (error) {
    const code = error instanceof ZenxError ? error.code : "COMMAND_FAILED";
    const message = error instanceof Error ? error.message : "签到失败。";
    const rateLimited = retryCodes.has(code) && context.attempt <= maxRetries;
    return { ...base, launched, ok: false, code, message, rateLimited };
  }
}
