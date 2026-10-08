import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readStore, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { creditedTodayAliases } from "./db.ts";
import { dailySnapshotSummary } from "./snapshot.ts";
import type { AutomaticSnapshotResult } from "./snapshot.ts";
import type { LaunchDependencies } from "./launch.ts";
import { checkinAccount } from "./checkin.ts";
import type { CheckinResult } from "./checkin.ts";
import { closeBrowser, closeLeftoverInstances, ensureOnline } from "./launch.ts";
import { recordLaunchedInstance } from "./leftover.ts";
import { enrichBskTimeout } from "./diagnose.ts";

/**
 * 站点登录限流后的默认冷却区间：15–18 分钟。
 *
 * 站点约 10–15 分钟恢复。原来 11–13 分钟的实测问题是"刚冷却完就再撞一次"，
 * 于是一轮签到里连着冷两次、多花二十几分钟（后半截的等待其实大半已经等过了）。
 * 下限抬到 15、上限 18：宁可多等两分钟，也别把整轮拖成两次冷却。
 * 取区间而不是定值：固定单一值容易被站点侧按节拍认出来。
 *
 * 关键是：限流不是账号级的，而是**站点侧的共享配额**——同一出口 IP 连续登录若干次后，
 * 站点对所有账号都只提示"登录次数过多请稍后再试"，此时继续跑只会把更多账号退出成登出态。
 * 正因为是共享配额、恢复只看墙钟，冷却就从**第一次撞上限流**起算：中途再撞只补足差额。
 */
export const DEFAULT_RETRY_WAIT_MIN_MS = 15 * 60_000;
export const DEFAULT_RETRY_WAIT_MAX_MS = 18 * 60_000;
/** 默认视为"可能是限流、值得冷却后重试"的错误码。 */
export const DEFAULT_RETRY_CODES = ["LOGIN_RATE_LIMITED", "LOGIN_TIMEOUT"];

const STATE_VERSION = 1;
const DEFAULT_CLOSE_TIMEOUT_MS = 45_000;
/**
 * BSK_TIMEOUT 即时重试的等待时间。首次 bsk 调用常因扩展/守护进程冷启动而超时
 * （edge-1 这类长期运行的用户自己的 Edge 尤其明显），短暂等待后重试通常成功。
 * 与限流冷却（15–18 分钟）不同，这是快速重试，不影响其他账号，也不消耗限流重试次数。
 */
const BSK_TIMEOUT_RETRY_DELAY_MS = 10_000;

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
  /** 本次自动快照的结果（saved/reused/incomplete/failed）；未采集时为 undefined。 */
  snapshot?: AutomaticSnapshotResult;
  /**
   * 该账号的 Edge 是否由本轮（含前面的轮次）拉起、且尚未关闭。
   * false 表示它本来就在跑（用户自己的）——只关自己拉起的实例是硬约束。
   */
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
  /**
   * 当日快照覆盖率：每个处理过的账号今天是否已有**配对**观测点（余额 + 累计消耗）。
   * 到账判定依赖它（见 recheck 的 Δ消耗基准），所以覆盖不全必须显式报出来，
   * 而不是等第二天判定静默退化成裸余额差。
   */
  snapshots: { ok: boolean; total: number; saved: number; missing: string[] };
  /** 开跑前的遗留实例清理汇总（仅 --close-leftover 时存在）。 */
  leftoverCleanup?: { tracked: number; closed: number; dropped: number; failed: number };
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
  /**
   * 限流冷却时长；默认在 15–18 分钟之间随机取值。显式指定时不抖动。
   * 它是"距首次限流"要等到的总时长，中途再撞限流只补足差额（见 checkinAll 里的 limitedSince）。
   * 无论冷却与否，失败的账号都会再补签一次（见 checkinAll 的收尾补签）。
   */
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
  /**
   * 开跑前先清理遗留实例：上一轮 zenx 拉起但没关掉的 Edge（记录在
   * leftover-instances.json），本轮只会被当成"用户自己的 Edge"永远保留。
   * 显式开启才会动它们——这些窗口现在可能有用户内容。
   */
  closeLeftover?: boolean;
  /** ensure-online 的依赖注入（测试替身）。 */
  launchDependencies?: LaunchDependencies;
  /** 同时在线的账号上限（默认 8）：一组签完就关掉再拉下一组，压住内存峰值；0 表示不分组。 */
  windowSize?: number;
  force?: boolean;
  now?: () => number;
  /** 墙钟（测试替身）：快照观测时间与日界用它；now 是计时器，不能混用。 */
  wallNow?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** 冷却时长的随机源（测试替身）；默认 Math.random。 */
  random?: () => number;
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
    // 只有复核确认离线才算释放：回包里的 closed 只是"请求已响应"。
    if (reply.outcome.instanceOffline) return { closed: true };
    return { closed: false, error: "关闭请求已响应，但复核时实例仍在注册表；未确认释放。" };
  } catch (error) {
    const message = error instanceof ZenxError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "关闭失败。";
    onProgress(`${alias}: 释放实例失败（${message}）；可稍后用 zenx accounts close 或 close-leftover 处理。`);
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

/** 分钟数：整数就不带小数（"18 分钟"），带零头的才显示一位（"16.4 分钟"）。 */
function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

/**
 * 分段等待，每段结束报告剩余时长。
 * 分段而不是一次 sleep：十几分钟没有任何输出时无法区分"在等冷却"和"卡住了"。
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
 * 3. 冷却等待期间已完成账号保持关闭状态，不会白占十几分钟内存；
 * 4. 失败的账号不会就此丢下：撞上限流时顺冷却一起重试，全程没限流也会在收尾补签一轮；
 * 5. 冷却时长是"距**首次**限流"要等到的总时长（默认 15–18 分钟）：共享配额的恢复只认墙钟，
 *    冷却后重试又撞上限流时只补足差额，不重新计满。
 */
export async function checkinAll(home: string, run: Runner, options: CheckinBatchOptions = {}): Promise<CheckinBatchReport> {
  const now = options.now ?? (() => Date.now());
  const wallNow = options.wallNow ?? (() => new Date());
  const sleep = options.sleep ?? delay;
  const random = options.random ?? Math.random;
  // 显式 --wait 是用户算好的时长，原样使用；走默认值才在 15–18 分钟之间随机取。
  const waitMinMs = options.waitMs ?? DEFAULT_RETRY_WAIT_MIN_MS;
  const waitMaxMs = options.waitMs ?? DEFAULT_RETRY_WAIT_MAX_MS;
  const pickWaitMs = () => Math.round(waitMinMs + random() * (waitMaxMs - waitMinMs));
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
    : creditedTodayAliases(wallNow(), options.dbFile);
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

  // 开跑前先清上一轮遗留：那些实例是 zenx 拉起的，只是上次没关掉——不清的话，
  // 本轮它们会被认成"用户自己的 Edge"而继续占着内存（还可能是卡死超时的根源）。
  let leftoverCleanup: CheckinBatchReport["leftoverCleanup"];
  if (options.closeLeftover === true) {
    const cleanup = await closeLeftoverInstances(home, run, DEFAULT_CLOSE_TIMEOUT_MS, options.launchDependencies, onProgress);
    leftoverCleanup = { tracked: cleanup.tracked, closed: cleanup.closed, dropped: cleanup.dropped, failed: cleanup.failed };
    if (cleanup.tracked > 0) {
      onProgress(`遗留实例清理：追踪 ${cleanup.tracked} 个，关闭 ${cleanup.closed} 个，移除记录 ${cleanup.dropped} 个，失败 ${cleanup.failed} 个`);
    }
  }

  const plan = windowSize > 0 ? chunkAccounts(todo, windowSize) : [todo];
  let rounds = 0;
  let waited = 0;
  let released = 0;
  /**
   * 本轮由 zenx 拉起、尚未关闭的实例（按别名记，跨轮共享）。
   *
   * 必须跨轮记忆：重试那一轮实例已经在线，ensure-online 不会再报 launched=true，
   * 只看当轮就会把"上一轮由 zenx 拉起、本轮该回收的 Edge"误判成用户自己的而永远不关
   * ——限流后冷却重试成功的账号（edge-p14 那类）就是这么漏掉的。
   */
  const ours = new Set<string>();
  /**
   * 补签队列：本轮失败过、重试次数还没用完的账号（按失败先后排队）。
   * 冷却那十几分钟是干等的，正好顺带把它们一起重试；全程没撞上限流时，
   * 收尾还会再给它们一轮（开头的账号卡在 BSK_TIMEOUT、后面一切顺利时尤其有用）。
   */
  const retryPool = new Map<string, Account>();
  /**
   * 本次限流窗口的起点：第一次撞到站点限流的时刻（null = 本次运行还没撞过）。
   *
   * 必须跨轮、跨组记忆：限流是站点侧的**共享配额**，恢复只认墙钟时间。
   * 冷却重试之后又撞上限流时，不能再从头等一整轮——从第一次撞上算起已经过去十几分钟了，
   * 只补足剩下的几分钟即可（原来每次都重新计满，一轮签到能白等两遍）。
   * 反过来，有账号真的签到成功就说明配额已经恢复：此时把起点清零，
   * 之后再来一次限流算新的一轮，重新等满——否则"上轮等到解除、这轮又立刻撞上"
   * 会被算成已经等够了，一次都不等就再撞一次墙。
   */
  let limitedSince: number | null = null;

  /** 从补签队列取出最多 limit 个账号；exclude 里已有的（本组剩余账号）跳过。 */
  const takeFromPool = (limit: number, exclude: Account[]): Account[] => {
    const taken: Account[] = [];
    for (const [alias, account] of retryPool) {
      if (taken.length >= limit) break;
      retryPool.delete(alias);
      if (exclude.some((item) => item.alias === alias)) continue;
      taken.push(account);
    }
    return taken;
  };

  /**
   * 冷却期间还能再塞几个补签账号：zenx 拉起的在线实例数不能超过窗口上限。
   * 已在重试名单里的本就占着位，不算进余量；用户自己的 Edge（非本轮拉起）不计入，
   * 窗口上限管的是 zenx 同时开着的实例数。
   */
  const roomInWindow = (group: Account[], deferred: Account[]): number => {
    if (windowSize <= 0) return Number.POSITIVE_INFINITY;
    const already = new Set(deferred.map((item) => item.alias));
    const stillOpen = group.filter((item) => !already.has(item.alias) && ours.has(item.alias)).length;
    return Math.max(0, windowSize - deferred.length - stillOpen);
  };

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

  for (let groupIndex = 0; groupIndex < plan.length; groupIndex++) {
    const group = plan[groupIndex];
    if (plan.length > 1) {
      onProgress(`[组 ${groupIndex + 1}/${plan.length}] ${group.length} 个账号（同时在线上限 ${windowSize}）`);
    }
    let pending: Account[] = group;
    let round = 0;
    /**
     * 本组（含从补签队列拉进来、属于前面组的账号）实际碰过的账号。
     * 收尾回收要覆盖它们：跨组补签会重新拉起 Edge，只回收本组会把这些实例漏在本轮之外，
     * 内存和 --close-after 都会失守。
     */
    const handled: Account[] = [...group];

    while (pending.length > 0) {
      round += 1;
      rounds += 1;
      const deferred: Account[] = [];
      for (let index = 0; index < pending.length; index++) {
        const account = pending[index];
        const attempt = (outcomes.get(account.alias)?.attempts ?? 0) + 1;
        onProgress(`[轮 ${round}] ${account.alias}: 第 ${attempt} 次签到`);
        const outcome = await runOne(home, run, account, { ...options, attempt, closeAfter, onProgress, now, sleep, ours });
        await remember(account.alias, outcome);
        if (outcome.ok) {
          // 已经成了，就不必再补签（它可能之前失败过、队列里还留着记录）。
          retryPool.delete(account.alias);
          // 真拿到当日额度= 站点的共享配额确实已经恢复：限流窗口就此结束，
          // 之后再来一次限流就从那一刻重新计冷却。
          if (outcome.credited) limitedSince = null;
          onProgress(`${account.alias}: ${outcome.skipped ? `跳过（${outcome.skipped}）` : `已到账 ${outcome.balanceBefore} → ${outcome.balanceAfter}`}`);
          continue;
        }
        onProgress(`${account.alias}: 失败 ${outcome.code ?? "UNKNOWN"} — ${outcome.message ?? ""}`);
        // 失败不是终局：排进补签队列，等冷却（或收尾）时再试一次。
        // 限流类错误码不进这个队列——它们是站点侧的共享配额，不冷却就重试只会再撞一次墙；
        // 它们走的是上面那条冷却重试的路子。
        // 每次尝试都刷新这条记录：次数用完或已经成功时必须**移出**队列，
        // 否则上次失败留下的旧记录会让收尾补签多跑一遍。
        if (outcome.attempts <= maxRetries && (outcome.code === undefined || !retryCodes.has(outcome.code))) {
          retryPool.set(account.alias, account);
        } else {
          retryPool.delete(account.alias);
        }
        if (outcome.rateLimited) {
          // 本轮剩下的账号同样会命中共享配额，一并推迟到冷却之后再试。
          deferred.push(...pending.slice(index));
          const deferredByLimit = deferred.length;
          // 冷却是干等的十几分钟，顺手把之前失败的账号也拉进来重试：多等一轮不再花时间，
          // 却给了开头卡在 BSK_TIMEOUT / PROFILE_CONNECT_TIMEOUT 的账号第二次机会。
          const piggyback = takeFromPool(roomInWindow(handled, deferred), deferred);
          if (piggyback.length > 0) {
            deferred.push(...piggyback);
            for (const item of piggyback) {
              if (!handled.some((known) => known.alias === item.alias)) handled.push(item);
            }
            onProgress(`冷却期间顺带重试 ${piggyback.length} 个之前失败的账号：${piggyback.map((item) => item.alias).join(", ")}`);
          }
          // 带上时间戳与错误码：限流是整轮最耗时的一步，事后排查全靠这几行。
          onProgress(
            `[${stamp(now())}] 命中站点登录限流（${outcome.code ?? "UNKNOWN"}，账号 ${account.alias}）：` +
              `剩余 ${deferredByLimit} 个账号推迟到冷却后重试`,
          );
          break;
        }
      }
      if (deferred.length === 0 || round > maxRetries) break;
      const coolStart = now();
      if (limitedSince === null) limitedSince = coolStart;
      // 冷却按墙钟计：从第一次撞限流算起，已经等过的部分不重复计入，只补足差额。
      const targetMs = pickWaitMs();
      const elapsedMs = coolStart - limitedSince;
      const cooldownMs = Math.max(0, targetMs - elapsedMs);
      const retryNames = deferred.map((item) => item.alias).join(", ");
      if (cooldownMs <= 0) {
        onProgress(
          `[${stamp(coolStart)}] 冷却已等够：自首次限流起已过 ${formatMinutes(elapsedMs)} 分钟（目标 ${formatMinutes(targetMs)} 分钟），` +
            `直接重试 ${deferred.length} 个账号：${retryNames}`,
        );
      } else {
        if (elapsedMs > 0) {
          onProgress(
            `[${stamp(coolStart)}] 距首次限流已过 ${formatMinutes(elapsedMs)} 分钟（目标 ${formatMinutes(targetMs)} 分钟），` +
              `本次只补足剩余部分`,
          );
        }
        onProgress(
          `[${stamp(coolStart)}] 冷却开始：${formatMinutes(cooldownMs)} 分钟（${stamp(coolStart + cooldownMs)} 结束），` +
            `随后重试 ${deferred.length} 个账号：${retryNames}`,
        );
        await sleepWithProgress(cooldownMs, sleep, onProgress);
        waited += cooldownMs;
        onProgress(`[${stamp(now())}] 冷却结束，开始重试 ${deferred.length} 个账号`);
      }
      pending = deferred;
    }

    // 这一组结束就释放它们的 Edge 实例：内存峰值 = 窗口大小，而不是账号总数。
    // 在窗口内失败也要关——失败的账号同样占着一个 Edge 进程（它停在哪一步都不影响这一点）。
    if (closeAfter || windowSize > 0) {
      for (const account of handled) {
        const current = outcomes.get(account.alias);
        if (current?.closed) continue;
        // 只关本轮拉起的实例。本来就在跑的那个 Edge 是用户自己的（共用同一 Profile），
        // 关掉会连标签页和未保存内容一起带走——省内存远不值得冒这个险。
        // 判定用跨轮的 ours：重试轮实例已在线，当轮的 launched 会是 false。
        if (!ours.has(account.alias)) {
          onProgress(`${account.alias}: 实例非本轮拉起（用户自己的 Edge），保留不关`);
          continue;
        }
        const release = await releaseInstance(home, run, account.alias, onProgress);
        if (release.closed) {
          released += 1;
          ours.delete(account.alias);
        }
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

    // 收尾补签：所有账号都跑完了，还有失败过且重试次数没用完的账号，就再给它们一轮。
    // 撞上限流的在冷却时已经顺带重试过（那时已从队列取走）；这里兜住的是"整轮都没限流"
    // 的情形——例如开头几个账号卡在 BSK_TIMEOUT，后面一路顺利，它们本该再试一次。
    if (groupIndex === plan.length - 1 && retryPool.size > 0) {
      const extra = takeFromPool(Number.POSITIVE_INFINITY, []);
      onProgress(`收尾补签：${extra.length} 个账号本轮失败过，再试一次：${extra.map((item) => item.alias).join(", ")}`);
      plan.push(...(windowSize > 0 ? chunkAccounts(extra, windowSize) : [extra]));
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
  // 快照覆盖率在**关窗之后**才汇总：这里只读账本，不再碰浏览器。
  // 采集本身已经在每个账号签到时就地完成（见 checkin.ts 的 finish），
  // 所以这一步看到的就是"今天实际落了多少配对观测点"。
  const snapshots = dailySnapshotSummary(accounts.map((item) => item.alias), wallNow(), options.dbFile);
  if (!snapshots.ok) {
    onProgress(
      `当日快照缺 ${snapshots.missing.length}/${snapshots.total} 个账号：${snapshots.missing.join(", ")}。` +
        `到账判定依赖配对快照，缺的账号明天会退化为裸余额差——可用 zenx accounts snapshot <别名> 单独补采（只读，不耗登录配额）。`,
    );
  }
  return {
    ok: failed === 0,
    total: accounts.length,
    credited: accounts.filter((item) => item.credited).length,
    failed,
    rounds,
    waitedMs: waited,
    /** 同时在线上限；0 表示不分组。 */
    windowSize,
    /** 分组数；含失败账号的收尾补签组。 */
    groups: plan.length,
    /** 本轮实际关闭的实例数（释放内存）。 */
    released,
    /** 开跑前就因"今天已到账"跳过、未拉起 Edge 的账号数。 */
    skippedAlreadyCredited: accounts.filter((item) => item.skipped === "already_credited_today" && item.attempts === 0).length,
    accounts,
    stateFile: file,
    snapshots,
    ...(leftoverCleanup ? { leftoverCleanup } : {}),
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
    /**
     * 本轮由 zenx 拉起、尚未关闭的实例（跨轮共享）。
     * 重试那一轮实例已在线，当轮的 launched 恒为 false，只看当轮会漏关
     * "上一轮拉起、这一轮签到成功"的实例。
     */
    ours: Set<string>;
    /** 墙钟（测试替身）：快照观测时间与"今天"的日界都用它，不能用 now（那是计时器）。 */
    wallNow?: () => Date;
  },
): Promise<AccountOutcome> {
  const retryCodes = new Set(context.retryCodes ?? DEFAULT_RETRY_CODES);
  const maxRetries = context.maxRetries ?? 1;
  const base = () => ({
    alias: account.alias,
    attempts: context.attempt,
    rateLimited: false,
    balanceBefore: null,
    balanceAfter: null,
    closed: false,
    credited: false,
    launched: context.ours.has(account.alias),
  });
  try {
    const online = await ensureOnline(home, run, account.alias, context.ensureTimeoutMs ?? 60_000, context.launchDependencies);
    if (online.launched === true) {
      context.ours.add(account.alias);
      // zenx 拉起的实例立刻落盘：这一步之后无论签到成败、关闭成败，
      // close-leftover 都能在事后识别出"这是 zenx 该负责的窗口"。
      await recordLaunchedInstance(home, account.alias, online.instanceId);
    }
  } catch (error) {
    const enriched = await enrichBskTimeout(error, run, { instanceId: account.instanceId });
    return {
      ...base(),
      ok: false,
      code: enriched instanceof ZenxError ? enriched.code : "COMMAND_FAILED",
      message: enriched instanceof Error ? enriched.message : "无法拉起 Edge。",
    };
  }
  const launched = context.ours.has(account.alias);
  try {
    let result: CheckinResult;
    try {
      result = await checkinAccount(home, run, account.alias, context.checkinTimeoutMs ?? 180_000, {
        force: context.force === true,
        dbFile: context.dbFile,
        now: context.now,
        wallNow: context.wallNow,
        sleep: context.sleep,
        onSnapshot: context.onProgress,
        // 只关 zenx 自己拉起的实例：账号本来就在线时，那个 Edge 是用户自己的，
        // 共用同一个 Profile —— 关掉会连标签页与未保存内容一起带走。
        // 用跨轮的 launched：上一轮拉起、这一轮才签到成功的实例同样要回收。
        closeAfter: context.closeAfter && launched,
      });
    } catch (firstError) {
      // BSK_TIMEOUT 即时重试一次：首次 bsk 调用常因扩展/守护进程冷启动而超时
      // （edge-1 这类长期运行的用户自己的 Edge 尤其明显），短暂等待后重试通常成功。
      // 与限流冷却不同，这是快速重试，不影响其他账号，也不消耗限流重试次数。
      if (!(firstError instanceof ZenxError) || firstError.code !== "BSK_TIMEOUT") throw firstError;
      context.onProgress(`${account.alias}: BSK_TIMEOUT，${BSK_TIMEOUT_RETRY_DELAY_MS / 1000}s 后自动重试一次`);
      await context.sleep(BSK_TIMEOUT_RETRY_DELAY_MS);
      result = await checkinAccount(home, run, account.alias, context.checkinTimeoutMs ?? 180_000, {
        force: context.force === true,
        dbFile: context.dbFile,
        now: context.now,
        wallNow: context.wallNow,
        sleep: context.sleep,
        onSnapshot: context.onProgress,
        closeAfter: context.closeAfter && launched,
      });
    }
    if (result.closed === true) context.ours.delete(account.alias);
    return {
      ...base(),
      launched,
      ok: result.ok,
      credited: result.checkinCredited === true && result.skipped === undefined,
      skipped: result.skipped,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      code: result.code,
      message: result.code === "CHECKIN_UNCONFIRMED" ? "流程跑完但未确认到账；用 zenx accounts recheck 核对。" : undefined,
      // 签到成功时 --close-after 已经关掉了实例：如实回传，免得收尾再关一次
      // 然后报一堆 INSTANCE_OFFLINE。
      closed: result.closed === true,
      ...(result.snapshot === undefined ? {} : { snapshot: result.snapshot }),
      ...(result.closureError === undefined ? {} : { closureError: result.closureError }),
    };
  } catch (error) {
    const enriched = await enrichBskTimeout(error, run, { instanceId: account.instanceId });
    const code = enriched instanceof ZenxError ? enriched.code : "COMMAND_FAILED";
    const message = enriched instanceof Error ? enriched.message : "签到失败。";
    const rateLimited = retryCodes.has(code) && context.attempt <= maxRetries;
    return { ...base(), launched, ok: false, code, message, rateLimited };
  }
}
