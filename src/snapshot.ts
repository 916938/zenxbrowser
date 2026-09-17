import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, withStoreLock, ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";
import { DEFAULT_DB_FILE, insertSnapshot } from "./db.ts";
import { readConsoleState } from "./console.ts";
import { findAccount } from "./launch.ts";

export type SnapshotDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 账本文件；默认项目根 zenxbrowser/checkin.db。 */
  dbFile?: string;
};

export type SnapshotResult = {
  ok: boolean;
  alias: string;
  instanceId: string;
  identity: string;
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
 * 只读：不退出、不重登、不消耗登录配额。失败也写一条（ok=false + 错误码），
 * 保证"每天都试过"这件事在账本里有痕（与 checkin 的失败留痕口径一致）。
 */
export async function snapshotAccount(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 45_000,
  dependencies: SnapshotDependencies = {},
): Promise<SnapshotResult> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? delay;
  const remaining = deadlineBudget(timeoutMs, now);
  const dbFile = dependencies.dbFile ?? DEFAULT_DB_FILE;
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
    const connection: SnapshotResult["connection"] = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";

    let result: SnapshotResult;
    let text = "";
    if (connection !== "online") {
      result = {
        ...base, ok: false, connection, login: "unknown", balance: null, totalSpent: null,
        errorCode: connection.toUpperCase(),
        note: "实例离线或不兼容；未读取站点。",
      };
    } else {
      const state = await readConsoleState(run, account.instanceId, account.expectedIdentity, remaining, sleep);
      text = state.text;
      const failure = state.login === "manual_intervention"
        ? { errorCode: "MANUAL_INTERVENTION_REQUIRED", note: "检测到 GitHub 授权/验证页；需人工登录。" }
        : state.login === "logged_out"
          ? { errorCode: "LOGGED_OUT", note: "当前未登录；读不到该账号的余额与消耗。" }
          : !state.identityMatch
            ? { errorCode: "IDENTITY_MISMATCH", note: `控制台未出现预期身份 ${account.expectedIdentity}。` }
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
    }

    insertSnapshot({
      time: new Date(now()).toISOString(),
      alias: result.alias,
      instanceId: result.instanceId,
      identity: result.identity,
      balance: result.balance,
      totalSpent: result.totalSpent,
      ok: result.ok,
      errorCode: result.errorCode ?? null,
    }, dbFile);
    void text;  // 正文只用于判定，不入账本（避免把页面内容写进数据库）
    return result;
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
      results.push(await snapshotAccount(home, run, account.alias, timeoutMs, dependencies));
    } catch (error) {
      results.push({
        ok: false,
        alias: account.alias,
        instanceId: account.instanceId,
        identity: account.expectedIdentity,
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
