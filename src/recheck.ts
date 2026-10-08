import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { DEFAULT_DB_FILE, hasCreditedBetween, insertCheckin, lastBalancePointBefore, lastPairedSnapshotBefore, ledgerAliasOf } from "./db.ts";
import { readConsoleState } from "./console.ts";
import { findAccount } from "./launch.ts";
import { agentRouter } from "./sites/agentrouter.ts";
import { anyRouter } from "./sites/anyrouter.ts";
import type { ReadableSite } from "./sites/readable.ts";

/** 可复查的站点，以及"这个账号在该站点的身份"（与 snapshot.ts 同一套口径）。 */
const SITES: { site: ReadableSite; identityOf: (account: Account) => string | undefined }[] = [
  { site: agentRouter, identityOf: (account) => account.expectedIdentity },
  { site: anyRouter, identityOf: (account) => account.anyrouterIdentity },
];

/** 按站点 id 取适配器；未知 id 返回 undefined，由调用方报错。 */
function siteById(id: string): { site: ReadableSite; identityOf: (account: Account) => string | undefined } | undefined {
  return SITES.find((entry) => entry.site.id === id);
}

/**
 * 配对消耗基准的最大年龄。
 *
 * Δ消耗只在两个观测点之间的时段里等于区间消耗，而"到账"每次登录最多发一次。
 * 基准越旧，窗口里包含的发放次数越多：快照停更十天后，Δ余额 + Δ消耗 会把十天的
 * 发放一起算成"今天的到账"，凭空判已到账（宁可漏判也不能造这种假）。
 * 日例行会给每个账号落一笔快照，因此超过两天没有配对观测点，说明数据已经不足以
 * 把窗口收敛到单日，此时放弃 Δ消耗、退化为只比余额。
 */
const MAX_BASELINE_AGE_MS = 48 * 60 * 60_000;

export type RecheckDependencies = {
  /** 返回 epoch 毫秒；同时用于超时预算与"今天"的日期边界。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 签到账本；默认项目根 zenxbrowser/checkin.db。 */
  dbFile?: string;
  /**
   * 确认到账但账本今天没有记录时，是否补记一条到账记录。默认 true。
   * 存在的理由：额度不一定由 checkin 发放（例如 `zenx accounts login` 恢复登录态也会发放），
   * 那种情况下钱是真领到了，账本却只有一条失败记录，报表会把它当成"没签到"。
   * 记账本不影响站点状态，也不消耗登录配额。
   */
  record?: boolean;
  /** 复查哪个站点（默认 AgentRouter）。 */
  siteId?: string;
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
  /** 站点 id；账本记录在 ledgerAliasOf(alias, site) 下。 */
  site: string;
  balance: number | null;
  siteCheckedIn: boolean;
  /** 账本里今天是否已有"确认到账"记录。 */
  creditedToday: boolean;
  /** 账本里今天开始前该账号的最后一次已知余额（发放前基准）。 */
  baselineBalance: number | null;
  /** 与 baselineBalance 同一时点的站点累计消耗；无快照时为 null。 */
  baselineTotalSpent: number | null;
  /** 站点累计消耗相对基线的增量；任一端读不到时为 null。 */
  spentDelta: number | null;
  /** 到账增量 = Δ余额 + Δ消耗；这是判定"是否已发放"的口径。 */
  creditDelta: number | null;
  /** 当前余额相对基线的增量（裸值，不含消耗）；任一端读不到时为 null。 */
  balanceDelta: number | null;
  verdict: "credited" | "not_credited" | "logged_out" | "manual_intervention" | "identity_mismatch" | "unknown";
  pageFeature?: string;
  note?: string;
  /** 本次是否为到账补记了一条签到记录（钱到了但账本原本没记录时才会发生）。 */
  recorded?: boolean;
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
 * 补记账本：确认到账、但今天还没有到账记录时补一条 credited 记录。
 *
 * 只为"钱已经领到、只是没走 checkin 路径"纠偏（例如用 `zenx accounts login` 恢复登录态
 * 触发发放）。写失败不影响复查结论——账本只是 Remembering，不是判定依据。
 */
function recordMissingCredit(
  ledgerAlias: string,
  instanceId: string,
  identity: string,
  balance: number | null,
  baselineBalance: number | null,
  creditedToday: boolean,
  dependencies: RecheckDependencies,
  now: number,
): boolean {
  if (dependencies.record === false || creditedToday) return false;
  try {
    insertCheckin({
      time: new Date(now).toISOString(),
      alias: ledgerAlias,
      instanceId,
      identity,
      ok: true,
      balanceBefore: baselineBalance,
      balanceAfter: balance,
      credited: true,
      errorCode: null,
    }, dependencies.dbFile ?? DEFAULT_DB_FILE);
    return true;
  } catch {
    return false;
  }
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
  const target = siteById(dependencies.siteId ?? agentRouter.id);
  if (target === undefined) {
    throw new ZenxError("UNKNOWN_SITE", `未知站点 ${dependencies.siteId}；可用：${SITES.map((s) => s.site.id).join(", ")}。`);
  }
  const { site, identityOf } = target;
  return withStoreLock(home, async () => {
    const store = await readStore(home);
    const account = findAccount(store, alias);
    const identity = identityOf(account);
    if (!identity) {
      throw new ZenxError("SITE_NOT_BOUND", `账号 ${alias} 未绑定 ${site.name} 身份；无法复查该站点。`);
    }
    // 账本按站点分开：AgentRouter 记在 alias，其他站点记在 alias@站点id。
    const ledgerAlias = ledgerAliasOf(account.alias, site.id);
    const base = { alias: account.alias, instanceId: account.instanceId, identity, site: site.id };

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
        baselineTotalSpent: null, spentDelta: null, creditDelta: null,
        verdict: "unknown", note: "实例离线或不兼容；未启动 Edge，未读取站点。先执行 ensure-online。",
      };
    }

    const state = await readConsoleState(run, account.instanceId, identity, remaining, sleep, site);
    const { balance, siteCheckedIn } = state;

    // 账本侧：今日到账记录 + 今日开始前的余额基准（含配对消耗）。
    const { start, end } = todayUtcRange(new Date(now()));
    let creditedToday = false;
    let baselineBalance: number | null = null;
    let baselineTotalSpent: number | null = null;
    let spentDelta: number | null = null;
    try {
      const dbFile = dependencies.dbFile ?? DEFAULT_DB_FILE;
      creditedToday = hasCreditedBetween(ledgerAlias, start, end, dbFile);
      const latest = lastBalancePointBefore(ledgerAlias, start, dbFile);
      baselineBalance = latest?.balance ?? null;
      /**
       * Δ消耗只在"配对观测点"上成立，因此要求扫到的快照同时满足两条：
       * 1) 它就是最新的余额观测点（之后没有更晚的签到记录/快照）——否则两者之间
       *    的那笔签到发放会被重复计进 Δ消耗，凭空凑出第二笔额度；
       * 2) 它足够新（见 MAX_BASELINE_AGE_MS）——否则跨多日的消耗与发放会一起
       *    算进今天，同样造出假到账。
       * 任一不满足都放弃 Δ消耗、退化为只比余额。
       */
      const paired = lastPairedSnapshotBefore(ledgerAlias, start, dbFile);
      const fresh = paired !== null && now() - Date.parse(paired.time) <= MAX_BASELINE_AGE_MS;
      if (paired && fresh && latest !== null && paired.time === latest.time) {
        baselineTotalSpent = paired.totalSpent;
        if (state.totalSpent !== null) {
          spentDelta = Math.max(0, Math.round((state.totalSpent - paired.totalSpent) * 100) / 100);
        }
      }
    } catch {
      // 账本读不了不能影响站点读数：只让判据退化，不报错。
    }
    const balanceDelta = balance !== null && baselineBalance !== null ? Math.round((balance - baselineBalance) * 100) / 100 : null;
    /**
     * 到账增量 = Δ余额 + Δ消耗。
     *
     * 为什么不能用裸余额差：余额同时被"签到发放"和"日常消耗"影响。间隔一天以上时，
     * 消耗会把余额差压到每日额度以下，把已到账误判成未到账——实测 edge-8：基准
     * 1126.31、当前 1147.49，裸差 21.18 < 25，但站点日志明确写着"每日签到成功
     * 增加额度 $25"，那 3.82 就是当天的消耗。加上 Δ消耗后就还原为 25。
     * 消耗读数缺失（没有配对快照）时退化为裸余额差：宁可漏判到账，也不要凭空加一笔
     * 消耗制造假到账。
     */
    const creditDelta = balanceDelta === null
      ? null
      : Math.round((balanceDelta + (spentDelta ?? 0)) * 100) / 100;

    if (state.login === "manual_intervention") {
      return {
        ...base, ok: false, connection, login: "manual_intervention", identityMatch: state.identityMatch,
        balance, siteCheckedIn, creditedToday, baselineBalance, balanceDelta,
        baselineTotalSpent, spentDelta, creditDelta,
        verdict: "manual_intervention", pageFeature: state.pageFeature,
        note: "检测到需人工处理的授权/验证页；需人工完成登录后重试。",
      };
    }
    if (state.login === "logged_out") {
      return {
        ...base, ok: false, connection, login: "logged_out", identityMatch: false,
        balance: null, siteCheckedIn: false, creditedToday, baselineBalance, balanceDelta: null,
        baselineTotalSpent, spentDelta: null, creditDelta: null,
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
        baselineTotalSpent, spentDelta, creditDelta,
        verdict: "identity_mismatch",
        note: `控制台未出现预期身份 ${identity}；不据此判断额度，请人工核对。`,
      };
    }

    const gained = creditDelta !== null && creditDelta >= site.dailyCredit;
    if (creditedToday || siteCheckedIn || gained) {
      const source = creditedToday ? "账本今日已有到账记录" : siteCheckedIn ? "站点显示今日已签到" : "余额相对基线已增长";
      return {
        ...base, ok: true, connection, login: "logged_in", identityMatch: true,
        balance, siteCheckedIn, creditedToday, baselineBalance, balanceDelta,
        baselineTotalSpent, spentDelta, creditDelta,
        verdict: "credited", note: `已确认今日到账（依据：${source}）。`,
        recorded: recordMissingCredit(ledgerAlias, account.instanceId, identity, balance, baselineBalance, creditedToday, dependencies, now()),
      };
    }
    return {
      ...base, ok: false, connection, login: "logged_in", identityMatch: true,
      balance, siteCheckedIn, creditedToday, baselineBalance, balanceDelta,
      baselineTotalSpent, spentDelta, creditDelta,
      verdict: "not_credited",
      note: balanceDelta === null
        ? "未发现到账证据（缺少发放前余额基准，无法比较增量）；可重试签到，或次日再看余额趋势。"
        : "未发现到账证据：账本今日无到账记录、站点未显示已签到、余额与消耗合计也无增长。可重试签到。",
    };
  });
}
