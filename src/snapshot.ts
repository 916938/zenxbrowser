import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner } from "./core.ts";
import { DEFAULT_DB_FILE, insertSnapshot, ledgerAliasOf } from "./db.ts";
import { readConsoleState } from "./console.ts";
import { findAccount } from "./launch.ts";
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
};

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
 * 只读：不退出、不重登、不消耗登录配额。失败也写一条（ok=false + 错误码），
 * 保证"每天都试过"这件事在账本里有痕（与 checkin 的失败留痕口径一致）。
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
  return withStoreLock(home, async () => {
    const store = await readStore(home);
    const account = findAccount(store, alias);
    // 只采"这个账号确实绑过身份"的站点；没绑的站点不是失败，跳过即可。
    const targets = SITES.filter(({ site, identityOf }) =>
      (dependencies.siteId === undefined || dependencies.siteId === site.id) && identityOf(account));
    if (targets.length === 0) return [];

    const browsers = await listBrowsers(run, {
      timeoutMs: 60_000,
      env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    const browser = browsers.find((item) => item.instance_id === account.instanceId);
    const connection: SnapshotResult["connection"] = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";

    const results: SnapshotResult[] = [];
    for (const { site, identityOf } of targets) {
      const identity = identityOf(account) ?? "";
      const base = { alias: account.alias, instanceId: account.instanceId, identity, site: site.id };
      // 每个站点一份独立预算：一个站点读超时不该把后面的站点也拖垮。
      const remaining = deadlineBudget(timeoutMs, now);
      let result: SnapshotResult;
      if (connection !== "online") {
        result = {
          ...base, ok: false, connection, login: "unknown", balance: null, totalSpent: null,
          errorCode: connection.toUpperCase(),
          note: "实例离线或不兼容；未读取站点。",
        };
      } else {
        try {
          const state = await readConsoleState(run, account.instanceId, identity, remaining, sleep, site);
          const failure = state.login === "manual_intervention"
            ? { errorCode: "MANUAL_INTERVENTION_REQUIRED", note: "检测到需人工处理的授权/验证页；需人工登录。" }
            : state.login === "logged_out"
              ? { errorCode: "LOGGED_OUT", note: "当前未登录；读不到该账号的余额与消耗。" }
              : !state.identityMatch
                ? { errorCode: "IDENTITY_MISMATCH", note: `控制台未出现预期身份 ${identity}。` }
                : undefined;
          // 页面隐藏（窗口被遮挡/后台）时控制台往往不渲染余额与消耗，正文里读不到。
          // 这不是失败，但这条快照没有观测价值，要明确提示，避免"有记录却全是空"被当成正常。
          const note = failure?.note ?? (state.balance === null || state.totalSpent === null
            ? "已记录，但页面未渲染出余额/消耗：窗口可能处于隐藏状态。激活该 Edge 窗口后重采一次才有效。"
            : "已记录余额与累计消耗。");
          result = {
            ...base, ok: failure === undefined, connection, login: state.login,
            balance: state.balance, totalSpent: state.totalSpent,
            ...(failure ?? { note }),
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
      results.push(result);
    }
    return results;
  });
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
