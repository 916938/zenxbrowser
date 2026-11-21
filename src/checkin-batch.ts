import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readStore, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { creditedTodayAliases, lastBalancePointBefore } from "./db.ts";
import { dailySnapshotSummary } from "./snapshot.ts";
import type { AutomaticSnapshotResult } from "./snapshot.ts";
import type { LaunchDependencies } from "./launch.ts";
import { checkinAccount } from "./checkin.ts";
import type { CheckinResult } from "./checkin.ts";
import { closeBrowser, closeLeftoverInstances, ensureOnline } from "./launch.ts";
import { recordLaunchedInstance } from "./leftover.ts";
import { recheckAccount, todayUtcRange } from "./recheck.ts";
import { enrichBskTimeout } from "./diagnose.ts";
import { anyrouterCheckinAll } from "./anyrouter-batch.ts";
import type { AnyRouterBatchReport } from "./anyrouter-batch.ts";

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
 * 每次撞上限流都重新等待完整冷却：冷却后的探测仍被拒，说明上一个截止时间判断错了，
 * 不能再以"距首次限流已经够久"为由立即重试，否则会把剩余账号连续撞成登出态。
 */
export const DEFAULT_RETRY_WAIT_MIN_MS = 15 * 60_000;
export const DEFAULT_RETRY_WAIT_MAX_MS = 18 * 60_000;
/** 默认视为"可能是限流、值得冷却后重试"的错误码。 */
export const DEFAULT_RETRY_CODES = ["LOGIN_RATE_LIMITED", "LOGIN_TIMEOUT"];

const STATE_VERSION = 1;
const DEFAULT_CLOSE_TIMEOUT_MS = 45_000;
/** 跳过名单最多点名几个别名；超出的只报数量。 */
const PRE_CREDITED_NAME_LIMIT = 5;
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
  /** 命中站点共享限流，或因前序账号限流而未能尝试。与是否还有重试额度无关。 */
  rateLimited: boolean;
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** 签到成功后是否已关闭该实例释放内存（未开 --close-after 时为 false）。 */
  closed: boolean;
  closureError?: string;
  /** 本次自动快照的结果（saved/reused/incomplete/failed）；未采集时为 undefined。 */
  snapshot?: AutomaticSnapshotResult;
  /**
   * 这次记为到账，但**没有增量凭证**：余额/消耗读不出来，只凭页面的"签到成功"
   * 提示判定。钱大概率到了（站点每天只在登录时发这一笔），但没核对过——
   * 汇总要点名，让人一眼看出该复核，而不是混在"到账 N 个"里。
   */
  unconfirmed?: boolean;
  /**
   * 该账号的 Edge 是否由本轮（含前面的轮次）拉起、且尚未关闭。
   * false 表示它本来就在跑（用户自己的）——只关自己拉起的实例是硬约束。
   */
  launched?: boolean;
  /**
   * 本次结果原本是 CHECKIN_UNCONFIRMED，经只读复核确认今日额度已到账后纠偏。
   * 与 unconfirmed 相反：那个是"记了到账但没凭证"，这个是"报了失败但复核有凭证"。
   */
  recoveredByRecheck?: boolean;
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
  /** 前置的 AnyRouter 阶段汇总（--anyrouter no 时不存在）。 */
  anyrouter?: AnyRouterBatchReport;
};

/**
 * "流程跑完但未确认到账"的只读复核结论。
 *
 * 站点是登录即发放、一天一次：当天早些时候（哪怕半途失败的）登录已经把额度发掉时，
 * 本次退出→重登不会二次发放，⑧ 的 "本次运行内 Δ余额 + Δ消耗" 必然为 0，于是报
 * CHECKIN_UNCONFIRMED —— 钱其实在账上。基线断档（>48h）时 ⑤d 的"今日已发放"短路
 * 又会因新鲜度门槛失效，这类误报会集中出现，并把账号推回收尾补签反复重登，
 * 直到撞上站点共享登录限流。
 *
 * 不放宽 ⑤d 的门槛：那会重新引入 10-24 修掉的静默漏签（基准停更几天后，几天的
 * 发放都落进窗口，什么都没做就记已到账）。改为在批量层用 recheck 的第二套口径
 * 独立复核：只读、不登录、不消耗登录配额，确认到账时补记账本，让明天有新鲜基线。
 */
export type UnconfirmedReview = {
  verdict: "credited" | "not_credited" | "unknown";
  /** 当前余额相对"今天开始前"基线的增量，仅供诊断。 */
  balanceDelta?: number | null;
  baselineBalance?: number | null;
};

/** 复核预算：只读一次控制台，不该比一次完整签到更久。 */
const REVIEW_TIMEOUT_MS = 45_000;
/** 与 checkin.ts / recheck.ts 同源：余额基准超过这个年龄，⑤d「今日已发放」短路就失效。 */
const BASELINE_MAX_AGE_MS = 48 * 60 * 60_000;

/**
 * 找出"今天开始前的最后余额观测点"已经停更超过两天的账号。
 *
 * 连续几天没跑时账本没有新观测点，⑤d 的新鲜度门槛会对**全部**账号失效：
 * 当天早些时候登录已发过额度的账号不会被短路放过，而是照常退出重登、余额不涨、
 * 报 CHECKIN_UNCONFIRMED。只报"当日快照缺 N 个"看不出这层因果（缺快照是结果，
 * 基线断档才是开关），所以单独点名。从没有基线的是新绑账号，不算断档。
 *
 * **时序要注意**：`start` 是今天 00:00 UTC，今天落下的观测点一律不参与基准计算，
 * 因此这条告警在当天无法靠补采消除——补采的快照要到明天才成为"今天开始前"的基准。
 * 收尾提示必须据此区分「今天还缺快照」（值得补采）与「今天已齐」（无需动作），
 * 否则会让用户白跑一次 snapshot --all，为二十个账号各拉起一遍 Edge。
 */
function staleBaselineAliases(aliases: string[], at: Date, dbFile?: string): string[] {
  const { start } = todayUtcRange(at);
  const stale: string[] = [];
  for (const alias of aliases) {
    try {
      const point = lastBalancePointBefore(alias, start, dbFile);
      if (point !== null && at.getTime() - Date.parse(point.time) > BASELINE_MAX_AGE_MS) stale.push(alias);
    } catch { /* 账本读不了就不告警，别让诊断打断收尾 */ }
  }
  return stale;
}

async function defaultReviewUnconfirmed(
  home: string,
  run: Runner,
  alias: string,
  dbFile?: string,
): Promise<UnconfirmedReview> {
  // record=true：确认到账但账本今天没记录时补记一条，否则明天它还会被当成待签到。
  // 批量内部的复核必须是纯只读：它要连的是刚才签到用的那个 Edge（见
  // deferCloseOnUnconfirmed），绝不能在这里另外拉起/关闭实例，否则会和本轮
  // 的 ours 追踪与窗口回收打架。用户手工跑 recheck 才默认自动拉起。
  const result = await recheckAccount(home, run, alias, REVIEW_TIMEOUT_MS, { dbFile, record: true, ensureOnline: false });
  return {
    verdict: result.verdict === "credited" ? "credited" : result.verdict === "not_credited" ? "not_credited" : "unknown",
    balanceDelta: result.balanceDelta,
    baselineBalance: result.baselineBalance,
  };
}

/**
 * 复核确认到账时把 CHECKIN_UNCONFIRMED 纠偏为成功。
 *
 * 只认三个条件同时成立：原结果是失败、错误码正是 CHECKIN_UNCONFIRMED、复核判 credited。
 * 其它失败码一律不动——IDENTITY_MISMATCH / LOGOUT_FAILED 之类不是"没法证明到账"，
 * 拿复核去洗掉它们会把真实故障藏起来。复核自身不可用（unknown / 抛错）时保持原判。
 */
export function applyUnconfirmedReview(outcome: AccountOutcome, review: UnconfirmedReview): AccountOutcome {
  if (outcome.ok || outcome.code !== "CHECKIN_UNCONFIRMED" || review.verdict !== "credited") return outcome;
  return {
    ...outcome,
    ok: true,
    credited: true,
    code: undefined,
    message: "流程内未观测到增量；只读复核确认今日额度已到账，不再重签。",
    recoveredByRecheck: true,
  };
}

/**
 * 给人看的收尾汇总。
 *
 * 为什么需要它：批量报告有二十个账号，逐条 JSON 打出来几百行，真正要回答的
 * 问题只有三个——钱领到了吗、谁出问题了、要不要人工处理。逐账号明细仍然留在
 * JSON 里（加 --json），屏幕上只留结论。
 */
export function summarizeBatchReport(report: CheckinBatchReport): string[] {
  const lines: string[] = [];
  const anyrouter = report.anyrouter;

  if (anyrouter && anyrouter.total > 0) {
    const skipped = anyrouter.skipped > 0 ? `，跳过 ${anyrouter.skipped}` : "";
    const released = anyrouter.released > 0 ? `，释放实例 ${anyrouter.released}` : "";
    lines.push(`AnyRouter：${anyrouter.total} 个账号，到账 ${anyrouter.credited}${skipped}，失败 ${anyrouter.failed}${released}`);
  }

  const parts = [`共 ${report.total} 个账号，到账 ${report.credited}`];
  if (report.skippedAlreadyCredited > 0) parts.push(`今天已到账而跳过 ${report.skippedAlreadyCredited}`);
  if (report.failed > 0) parts.push(`失败 ${report.failed}`);
  if (report.released > 0) parts.push(`释放实例 ${report.released}`);
  if (report.waitedMs > 0) parts.push(`限流冷却 ${(report.waitedMs / 60_000).toFixed(1)} 分钟`);
  lines.push(`AgentRouter：${parts.join("，")}`);

  // 失败必须点名：它是唯一需要人动手的部分，混在汇总数字里等于没说。
  const failures = report.accounts.filter((item) => !item.ok);
  if (failures.length > 0) {
    lines.push(`需要处理的账号：${failures.map((item) => `${item.alias}（${item.code ?? "UNKNOWN"}）`).join("、")}`);
  }
  // 疑似到账单列：它算在"到账"里，但没有增量凭证（页面余额读不到，只凭提示判定）。
  // 混在到账数字里等于告诉人"签上了"，实际这几个恰恰是要人工复核的。
  const unconfirmed = report.accounts.filter((item) => item.unconfirmed === true && item.ok);
  if (unconfirmed.length > 0) {
    lines.push(
      `未确认到账（凭页面提示判定，未核对到增量）：${unconfirmed.map((item) => item.alias).join("、")}` +
        `；用 zenx accounts recheck <别名> 复核，确要重签用 zenx accounts checkin <别名> --force。`,
    );
  }
  // 复核纠偏单列：它们原本在失败名单里，纠偏后不再出现，但人得知道这几个曾经判错、
  // 以及账本已被补记——否则会以为今天压根没跑过这些账号。
  const recovered = report.accounts.filter((item) => item.recoveredByRecheck === true);
  if (recovered.length > 0) {
    lines.push(`复核确认到账（原判 CHECKIN_UNCONFIRMED，已补记账本、不再重签）：${recovered.map((item) => item.alias).join("、")}`);
  }
  if (anyrouter && anyrouter.failed > 0) {
    const failedNames = anyrouter.accounts.filter((item) => !item.ok).map((item) => `${item.alias}（${item.code ?? "UNKNOWN"}）`);
    if (failedNames.length > 0) lines.push(`AnyRouter 需处理：${failedNames.join("、")}`);
  }

  if (!report.snapshots.ok) {
    lines.push(`当日快照缺 ${report.snapshots.missing.length}/${report.snapshots.total} 个：${report.snapshots.missing.join(", ")}；可用 zenx accounts snapshot <别名> 补采（只读）。`);
  }

  lines.push(report.ok ? "结论：今天该签的都签上了。" : "结论：有账号没签上，见上面需处理的名单。");
  return lines;
}

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
  /**
   * 在 AgentRouter 之前先跑一遍 AnyRouter 签到（默认开启，`false` 可关闭）。
   *
   * 顺序不是随意的：AnyRouter 只有两个账号而 AgentRouter 有二十个，先跑便宜的
   * 那一段，即使后面撞上站点限流要等 15 分钟，钱也已经落袋了。
   */
  anyrouter?: boolean;
  /** 限定账号；缺省为 store 里的全部账号。 */
  aliases?: string[];
  checkinTimeoutMs?: number;
  ensureTimeoutMs?: number;
  /**
   * 每次限流后的完整冷却时长；默认在 15–18 分钟之间随机取值，显式指定时不抖动。
   * 冷却后仍限流会重新等待，不做零时长的立即重试。
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
  /**
   * CHECKIN_UNCONFIRMED 的只读复核（测试替身）。默认调用 recheckAccount：
   * 用账本基线 + 站点状态给出第二意见，确认到账时补记账本。
   * 复核失败不改变签到结论，也不会被当成一次重试。
   */
  reviewUnconfirmed?: (alias: string) => Promise<UnconfirmedReview>;
  /** 单账号签到实现（测试替身）；缺省为生产 checkinAccount。 */
  runCheckin?: typeof checkinAccount;
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
 * 5. 每次限流都等待完整冷却（默认 15–18 分钟）；重试预算按账号自己的 attempts 计算，
 *    不按组内轮数计算，排在后面的未尝试账号不会因前序账号反复失败而被丢弃。
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
  const review = options.reviewUnconfirmed ?? ((alias: string) => defaultReviewUnconfirmed(home, run, alias, options.dbFile));
  const file = stateFileFor(home, options.stateFile);
  const outcomes = new Map<string, AccountOutcome>();
  const state = await readState(file);

  // 开跑前先清上一轮遗留：那些实例是 zenx 拉起的，只是上次没关掉——不清的话，
  // 本轮它们会被认成"用户自己的 Edge"而继续占着内存（还可能是卡死超时的根源）。
  // 必须排在 AnyRouter 阶段之前：那段也会按需拉起 Edge，清晚了就会和它拉起的实例混在一起。
  let leftoverCleanup: CheckinBatchReport["leftoverCleanup"];
  if (options.closeLeftover === true) {
    const cleanup = await closeLeftoverInstances(home, run, DEFAULT_CLOSE_TIMEOUT_MS, options.launchDependencies, onProgress);
    leftoverCleanup = { tracked: cleanup.tracked, closed: cleanup.closed, dropped: cleanup.dropped, failed: cleanup.failed };
    if (cleanup.tracked > 0) {
      onProgress(`遗留实例清理：追踪 ${cleanup.tracked} 个，关闭 ${cleanup.closed} 个，移除记录 ${cleanup.dropped} 个，失败 ${cleanup.failed} 个`);
    }
  }

  // AnyRouter 阶段前置：账号少（2 个）、又不消耗站点登录配额，先把这段跑完再动
  // 那 20 个号——万一后面撞上限流要等 15 分钟，这边的钱已经落袋了。
  let anyrouterReport: AnyRouterBatchReport | undefined;
  if (options.anyrouter !== false) {
    anyrouterReport = await anyrouterCheckinAll(home, run, {
      timeoutMs: options.checkinTimeoutMs,
      dbFile: options.dbFile,
      force: options.force,
      closeAfter,
      launchDependencies: options.launchDependencies,
      onProgress,
    });
    if (anyrouterReport.total > 0) {
      onProgress(
        `AnyRouter 阶段：共 ${anyrouterReport.total} 个，到账 ${anyrouterReport.credited}，` +
          `跳过 ${anyrouterReport.skipped}，失败 ${anyrouterReport.failed}` +
          (closeAfter ? `，释放实例 ${anyrouterReport.released} 个` : ""),
      );
    }
  }

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
  const preCreditedNames: string[] = [];
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
      preCreditedNames.push(account.alias);
      continue;
    }
    todo.push(account);
  }
  /**
   * 跳过的账号**聚合成一行**再报：二十个账号各打一行会把真正要看的东西
   * （谁签上了、谁失败了）冲出屏幕，而"今天已到账"本来就是同一件事重复二十遍。
   * 名单在点名前截断：它只是核对用，撑爆一行反而更难看。
   */
  if (preCreditedNames.length > 0) {
    const shown = preCreditedNames.slice(0, PRE_CREDITED_NAME_LIMIT);
    const rest = preCreditedNames.length - shown.length;
    onProgress(
      `跳过 ${preCreditedNames.length} 个账号（账本显示今天已到账，不拉起 Edge）：${shown.join(", ")}` +
        (rest > 0 ? ` 等（另有 ${rest} 个）` : ""),
    );
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
  /** 因前序账号触发共享限流而推迟、尚未真正尝试的账号。 */
  const rateLimitDeferred = new Set<string>();
  /**
   * 整轮兜底名单：**一次都没真正尝试过**的账号。
   * 反复失败且已用尽重试次数的账号不在这里补，避免架空 maxRetries。
   */
  const unresolved = new Map<string, Account>();
  /** 兜底只做一次：补签组自己再失败时不能无限追加新组。 */
  let sweepDone = false;
  /** 未启用重试时撞上限流，后续组也不能继续消耗站点登录配额。 */
  let stopRemainingGroups = false;

  const notAttemptedOutcome = (account: Account): AccountOutcome => {
    const deferred = rateLimitDeferred.has(account.alias);
    return {
      alias: account.alias,
      ok: false,
      code: deferred ? "RATE_LIMIT_DEFERRED" : "NOT_ATTEMPTED",
      message: deferred
        ? "因站点共享登录限流而推迟，本次未获得尝试机会；稍后重跑 checkin-all。"
        : "本轮未尝试。",
      credited: false,
      attempts: 0,
      rateLimited: deferred,
      balanceBefore: null,
      balanceAfter: null,
      closed: false,
    };
  };

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
        rateLimitDeferred.delete(account.alias);
        const attempt = (outcomes.get(account.alias)?.attempts ?? 0) + 1;
        onProgress(`[轮 ${round}] ${account.alias}: 第 ${attempt} 次签到`);
        let outcome = await runOne(home, run, account, { ...options, attempt, closeAfter, onProgress, now, sleep, ours });
        // CHECKIN_UNCONFIRMED 只是"本次运行内没法证明到账"，不等于没到账：当天早些时候
        // 登录已经把额度发掉时，重登不会二次发放，余额必然纹丝不动。先拿一次只读的
        // 第二意见，确认到账就当场纠偏——否则它会被丢进补签队列反复退出重登，
        // 白耗站点共享登录配额，最后撞上 LOGIN_RATE_LIMITED。
        if (!outcome.ok && outcome.code === "CHECKIN_UNCONFIRMED") {
          let verdict: UnconfirmedReview | undefined;
          try { verdict = await review(account.alias); }
          catch { /* 复核失败（实例离线/读页超时）不改变签到结论 */ }
          if (verdict) {
            const corrected = applyUnconfirmedReview(outcome, verdict);
            if (corrected.recoveredByRecheck === true) {
              outcome = corrected;
              onProgress(`${account.alias}: 只读复核确认今日已到账（原判 CHECKIN_UNCONFIRMED），已补记账本、不再重签`);
            } else {
              onProgress(
                `${account.alias}: 复核未确认到账（${verdict.verdict}，相对基线增量 ${verdict.balanceDelta ?? "—"}）；` +
                  `保留原判，可用 zenx accounts recheck ${account.alias} 人工复核`,
              );
            }
          }
        }
        await remember(account.alias, outcome);
        if (outcome.ok) {
          // 已经成了，就不必再补签（它可能之前失败过、队列里还留着记录）。
          retryPool.delete(account.alias);
          // 疑似到账必须和确认到账分开说：两者在汇总里都是"到账"，但前者没有凭证，
          // 屏幕上都写成"已到账"的话，真正要人工核对的那几个会被淹没。
          onProgress(
            outcome.skipped
              ? `${account.alias}: 跳过（${outcome.skipped}）`
              : outcome.unconfirmed === true
                ? `${account.alias}: 疑似到账，未确认（读不到余额/消耗，${outcome.balanceBefore} → ${outcome.balanceAfter}）——建议 recheck 复核`
                : `${account.alias}: 已到账 ${outcome.balanceBefore} → ${outcome.balanceAfter}`,
          );
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
          // 限流状态与重试额度无关：即使当前账号已经用完重试，也必须熔断后续账号。
          // 但已用完额度的账号本身不再入队；其余账号按各自的 attempts 判断，不能按组内轮数截断。
          const affected = pending.slice(index);
          for (const item of affected) {
            if ((outcomes.get(item.alias)?.attempts ?? 0) === 0) rateLimitDeferred.add(item.alias);
          }
          deferred.push(...affected.filter((item) => (outcomes.get(item.alias)?.attempts ?? 0) <= maxRetries));
          if (maxRetries === 0) stopRemainingGroups = true;
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
      if (deferred.length === 0 || maxRetries === 0) break;
      const coolStart = now();
      // 上次冷却后的探测仍然限流，证明旧截止时间不够；必须重新等完整冷却。
      // 绝不能按"距首次限流"补足成 0 分钟后立即重试，那正是连续撞限流的根源。
      const cooldownMs = pickWaitMs();
      const retryNames = deferred.map((item) => item.alias).join(", ");
      onProgress(
        `[${stamp(coolStart)}] 冷却开始：${formatMinutes(cooldownMs)} 分钟（${stamp(coolStart + cooldownMs)} 结束），` +
          `随后重试 ${deferred.length} 个账号：${retryNames}`,
      );
      await sleepWithProgress(cooldownMs, sleep, onProgress);
      waited += cooldownMs;
      onProgress(`[${stamp(now())}] 冷却结束，开始重试 ${deferred.length} 个账号`);
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
          ...(current ?? notAttemptedOutcome(account)),
          closed: release.closed,
          closureError: release.error,
        });
        if (release.closed) {
          state.accounts[account.alias] = { ...state.accounts[account.alias], lastResult: "closed" };
          await writeState(file, state);
        }
      }
    }

    // 一次都没真正尝试过的账号进入兜底名单；反复失败且已用尽重试次数的不在这里补。
    for (const account of handled) {
      const current = outcomes.get(account.alias);
      if (current?.ok === true) unresolved.delete(account.alias);
      else if (!current || current.attempts === 0) unresolved.set(account.alias, account);
    }

    if (stopRemainingGroups) {
      for (const rest of plan.slice(groupIndex + 1).flat()) {
        if ((outcomes.get(rest.alias)?.attempts ?? 0) === 0) rateLimitDeferred.add(rest.alias);
      }
      onProgress("未启用限流重试（--retries 0）：停止后续分组，避免继续消耗站点登录配额。");
      break;
    }

    // 收尾补签：所有账号都跑完了，还有没签上的账号就再给它们一轮。
    // 撞上限流的在冷却时已经顺带重试过（那时已从队列取走）；这里兜住的是"整轮都没限流"
    // 的情形——例如开头几个账号卡在 BSK_TIMEOUT，后面一路顺利，它们本该再试一次。
    // 名单 = 补签队列里剩下的，加上那些一次都没轮到的账号。
    if (groupIndex === plan.length - 1 && !sweepDone && maxRetries > 0) {
      const extra = new Map<string, Account>();
      for (const [alias, account] of retryPool) extra.set(alias, account);
      for (const [alias, account] of unresolved) extra.set(alias, account);
      for (const alias of [...extra.keys()]) {
        if (outcomes.get(alias)?.ok === true) extra.delete(alias);
      }
      if (extra.size > 0) {
        sweepDone = true;
        const list = [...extra.values()];
        onProgress(`收尾补签：${list.length} 个账号仍未签上，最后再试一次：${list.map((item) => item.alias).join(", ")}`);
        plan.push(...(windowSize > 0 ? chunkAccounts(list, windowSize) : [list]));
      }
    }
  }

  const accounts = wanted.map((account) => outcomes.get(account.alias) ?? notAttemptedOutcome(account));
  const failed = accounts.filter((item) => !item.ok).length;
  // 快照覆盖率在**关窗之后**才汇总：这里只读账本，不再碰浏览器。
  // 采集本身已经在每个账号签到时就地完成（见 checkin.ts 的 finish），
  // 所以这一步看到的就是"今天实际落了多少配对观测点"。
  const snapshots = dailySnapshotSummary(accounts.map((item) => item.alias), wallNow(), options.dbFile);
  if (!snapshots.ok) {
    onProgress(
      `当日快照缺 ${snapshots.missing.length}/${snapshots.total} 个账号：${snapshots.missing.join(", ")}。` +
        `到账判定依赖配对快照，缺的账号明天会退化为裸余额差——跑 zenx accounts snapshot --missing --capture 一键补采（自动拉起离线实例，站点侧只读、不耗登录配额）。`,
    );
  }
  const stale = staleBaselineAliases(accounts.map((item) => item.alias), wallNow(), options.dbFile);
  if (stale.length > 0) {
    const shown = stale.slice(0, PRE_CREDITED_NAME_LIMIT);
    const rest = stale.length - shown.length;
    // 基准只认今天 00:00 UTC 之前的观测点：今天补采的快照要到明天才生效。
    // 今天快照已齐时没有任何能当天修复这个告警的动作，别让用户白跑一次全量重采。
    const recovery = snapshots.ok
      ? "今天每个账号都已有配对快照，它们从明天起就是新鲜基准，无需补采；今天这几个账号会照常执行完整签到（不会误跳过），若报 CHECKIN_UNCONFIRMED 可用 zenx accounts recheck <别名> 只读核实到账。"
      : "今天还有账号缺配对快照：跑 zenx accounts snapshot --missing --capture 补采（自动拉起离线实例、站点侧只读），补上的观测点从明天起恢复基准；今天之内这条告警不会消失。";
    onProgress(
      `余额基线已停更超过 48 小时：${stale.length}/${accounts.length} 个账号（${shown.join(", ")}${rest > 0 ? ` 等（另有 ${rest} 个）` : ""}）。` +
        `基准只取今天 00:00 UTC 之前的观测点，因此「今日已发放」短路对这些账号今天失效，已到账也可能被判成 CHECKIN_UNCONFIRMED；` +
        recovery,
    );
  }
  // AnyRouter 也是"今天该签的号"，它的失败同样不能让整轮以 0 收尾——否则脚本
  // 会把"AnyRouter 没签上"当成"全部签完了"。
  const anyrouterFailed = anyrouterReport?.failed ?? 0;
  return {
    ok: failed === 0 && anyrouterFailed === 0,
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
    ...(anyrouterReport ? { anyrouter: anyrouterReport } : {}),
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
    /** 单账号签到实现（测试替身）；缺省为生产 checkinAccount。 */
    runCheckin?: typeof checkinAccount;
  },
): Promise<AccountOutcome> {
  const retryCodes = new Set(context.retryCodes ?? DEFAULT_RETRY_CODES);
  const invoke = context.runCheckin ?? checkinAccount;
  /**
   * 拉起事实要在 ensureOnline **返回之前**登记。连接超时（PROFILE_CONNECT_TIMEOUT）
   * 时它只会抛错，成功路径里的 ours.add / recordLaunchedInstance 根本走不到；
   * 那个刚拉起的 Edge 于是被当成"用户自己的"，--close-after 不关、追踪文件也没记录，
   * 每失败一轮就多留一个进程。见 launch.ts 的 onLaunched。
   */
  const launchDependencies: LaunchDependencies = {
    ...context.launchDependencies,
    onLaunched: async (instanceId) => {
      await context.launchDependencies?.onLaunched?.(instanceId);
      context.ours.add(account.alias);
      await recordLaunchedInstance(home, account.alias, instanceId);
    },
  };
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
    const online = await ensureOnline(home, run, account.alias, context.ensureTimeoutMs ?? 60_000, launchDependencies);
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
      result = await invoke(home, run, account.alias, context.checkinTimeoutMs ?? 180_000, {
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
        // 批量层要在 CHECKIN_UNCONFIRMED 上做只读复核，复核得连同一个实例。
        deferCloseOnUnconfirmed: true,
      });
    } catch (firstError) {
      // BSK_TIMEOUT 即时重试一次：首次 bsk 调用常因扩展/守护进程冷启动而超时
      // （edge-1 这类长期运行的用户自己的 Edge 尤其明显），短暂等待后重试通常成功。
      // 与限流冷却不同，这是快速重试，不影响其他账号，也不消耗限流重试次数。
      if (!(firstError instanceof ZenxError) || firstError.code !== "BSK_TIMEOUT") throw firstError;
      context.onProgress(`${account.alias}: BSK_TIMEOUT，${BSK_TIMEOUT_RETRY_DELAY_MS / 1000}s 后自动重试一次`);
      await context.sleep(BSK_TIMEOUT_RETRY_DELAY_MS);
      result = await invoke(home, run, account.alias, context.checkinTimeoutMs ?? 180_000, {
        force: context.force === true,
        dbFile: context.dbFile,
        now: context.now,
        wallNow: context.wallNow,
        sleep: context.sleep,
        onSnapshot: context.onProgress,
        closeAfter: context.closeAfter && launched,
        // 批量层要在 CHECKIN_UNCONFIRMED 上做只读复核，复核得连同一个实例。
        deferCloseOnUnconfirmed: true,
      });
    }
    if (result.closed === true) context.ours.delete(account.alias);
    // 走到文本信号判"到账"的那条路径：算已到账，但没有增量凭证（余额读不出来）。
    const unconfirmed = result.unconfirmed === true;
    return {
      ...base(),
      launched,
      ok: result.ok,
      credited: result.checkinCredited === true && result.skipped === undefined,
      rateLimited: !result.ok && retryCodes.has(result.code ?? ""),
      skipped: result.skipped,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      code: result.code,
      ...(unconfirmed ? { unconfirmed: true } : {}),
      message: unconfirmed
        ? "已入账但未确认：余额/消耗读不出来，只凭页面提示判定；用 zenx accounts recheck 复核。"
        : result.code === "CHECKIN_UNCONFIRMED"
          ? "流程跑完但未确认到账；用 zenx accounts recheck 核对。"
          : undefined,
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
    // 最后一次失败也仍然是站点限流：批量层必须熔断后续账号，只是不再重试当前账号。
    const rateLimited = retryCodes.has(code);
    return { ...base(), launched, ok: false, code, message, rateLimited };
  }
}
