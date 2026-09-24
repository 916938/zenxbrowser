import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, updateStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner, Store } from "./core.ts";
import { isLaunchConfig } from "./launch-config.ts";
import { clearLaunchedInstance, markLeftoverCloseError, readLeftovers } from "./leftover.ts";
import { isTabId, inspectAgentRouter, openAgentRouter } from "./site.ts";
import { readProfileAccount } from "./profile-account.ts";
import { detectProfile, listEdgeWindowTitles } from "./window-titles.ts";
import type { LaunchConfig } from "./launch-config.ts";

export type { LaunchConfig } from "./launch-config.ts";
export type LaunchDependencies = {
  launch?: (config: LaunchConfig) => Promise<void>;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 启动后等待窗口挂载的探测钩子；返回新窗口所属 Profile 是否匹配。 */
  detectProfile?: (before: string[], profileDirectory: string) => Promise<string | null>;
  listWindowTitles?: () => Promise<string[]>;
  /** 读取 Profile 账号锚点的钩子；默认读 `Preferences` 的 account_id。 */
  readProfileAccount?: (userDataDir: string, profileDirectory: string) => Promise<{ accountId: string; profileName: string }>;
};

export function findAccount(store: Store, alias: string): Account {
  const account = store.accounts.find((item) => item.alias === alias);
  if (!account) throw new ZenxError("ACCOUNT_NOT_FOUND", "账号别名尚未绑定；请先核对并绑定精确实例 ID。");
  return account;
}

function normalizePath(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase();
}

function contained(root: string, child: string): boolean {
  const relative = win32.relative(root, child);
  return relative !== "" && relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative);
}

async function validatePaths(config: LaunchConfig): Promise<void> {
  if (!isLaunchConfig(config)) throw new ZenxError("INVALID_LAUNCH_CONFIG", "需要绝对 Windows msedge.exe 路径、绝对用户数据目录以及单个安全 Profile 子目录名。");
  try {
    if (!(await stat(config.edgePath)).isFile()) throw new Error();
    if (!(await stat(config.userDataDir)).isDirectory()) throw new Error();
    const root = await realpath(config.userDataDir);
    const profile = win32.join(config.userDataDir, config.profileDirectory);
    if (!(await stat(profile)).isDirectory()) throw new Error();
    const resolvedProfile = await realpath(profile);
    if (!contained(root, resolvedProfile)) throw new Error();
    const preferences = win32.join(profile, "Preferences");
    if (!(await stat(preferences)).isFile() || !contained(resolvedProfile, await realpath(preferences))) throw new Error();
  } catch {
    throw new ZenxError("INVALID_LAUNCH_PATH", "Edge 文件、用户数据目录和含 Preferences 文件的既有 Profile 必须存在；Profile 或标志文件链接不得逃逸所属目录。不会创建 Profile。");
  }
}

async function existingPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return path;
    throw new ZenxError("INVALID_LAUNCH_PATH", "无法核对已有启动配置路径；请检查目录权限后重试。");
  }
}

async function profileKeys(config: LaunchConfig): Promise<string[]> {
  const root = await existingPath(config.userDataDir);
  const profile = win32.join(config.userDataDir, config.profileDirectory);
  return [profile, win32.join(root, config.profileDirectory), await existingPath(profile)].map(normalizePath);
}

async function rejectSharedProfile(store: Store, alias: string, config: LaunchConfig): Promise<void> {
  const keys = new Set(await profileKeys(config));
  for (const account of store.accounts) {
    if (account.alias === alias || !account.launch) continue;
    if ((await profileKeys(account.launch)).some((key) => keys.has(key))) {
      throw new ZenxError("LAUNCH_PROFILE_IN_USE", "该用户数据目录和 Profile 已配置给其他账号；不会复用或改绑。");
    }
  }
}

export async function configureLaunch(home: string, alias: string, config: LaunchConfig, confirm: boolean): Promise<Account> {
  if (!confirm) throw new ZenxError("CONFIRM_REQUIRED", "保存或修改启动路径需要 --confirm；路径必须由用户明确核对，不会推断 Profile 名称。");
  if (!isLaunchConfig(config)) throw new ZenxError("INVALID_LAUNCH_CONFIG", "启动配置必须包含有效的 Windows 绝对路径和安全 Profile 子目录名。");
  const launch = { edgePath: config.edgePath, userDataDir: config.userDataDir, profileDirectory: config.profileDirectory };
  return updateStore(home, async (store) => {
    const account = findAccount(store, alias);
    await validatePaths(launch);
    await rejectSharedProfile(store, alias, launch);
    account.launch = { ...account.launch, ...launch };
    // 记录账号锚点：实例 ID 变化后可按 account_id 重新定位，不必依赖会被改名的
    // Profile 显示名。读不到就保持原样，不往配置里写空值。
    const anchor = await readProfileAccount(launch.userDataDir, launch.profileDirectory);
    if (anchor.accountId) {
      account.profileAccountId = anchor.accountId;
      account.profileAccountSource = "preferences";
    }
    return account;
  });
}

/** 探测窗口归属时的轮询参数（窗口挂载需要时间，不能只 sleep 固定值）。 */
const PROFILE_PROBE_INTERVAL_MS = 500;
const PROFILE_PROBE_ATTEMPTS = 12;

function parseSessionStart(raw: string): string {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("bad json"); }
  if (typeof value !== "object" || value === null) throw new Error("bad shape");
  const sessionId = (value as { session_id?: unknown }).session_id;
  if (typeof sessionId !== "string" || !/^[a-z0-9]{4,12}$/i.test(sessionId)) throw new Error("bad id");
  return sessionId;
}

async function launchEdge(config: LaunchConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.edgePath, [
      `--user-data-dir=${config.userDataDir}`,
      `--profile-directory=${config.profileDirectory}`,
    ], { shell: false, detached: true, stdio: "ignore" });
    child.once("error", () => reject(new ZenxError("EDGE_LAUNCH_FAILED", "无法启动已配置的 Edge；请检查可执行文件和系统权限。")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function deadlineBudget(timeoutMs: number, dependencies: LaunchDependencies, site = false): () => number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ZenxError("INVALID_TIMEOUT", "等待预算必须是 1–300000 毫秒的整数。");
  }
  const now = dependencies.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  return () => {
    const budget = Math.floor(deadline - now());
    if (budget < 1) {
      throw site
        ? new ZenxError("SITE_TIMEOUT", "打开站点的总预算已耗尽；停止操作，不重试、不改选实例，也不关闭 Edge。")
        : new ZenxError("PROFILE_CONNECT_TIMEOUT", "目标实例未在期限内连接：配置可能不匹配、扩展被禁用或实例 ID 已变化，需要人工检查；不会改选其他实例，也不会关闭已启动的 Edge。");
    }
    return budget;
  };
}

async function ensureOnlineLocked(store: Store, account: Account, run: Runner, remaining: () => number, dependencies: LaunchDependencies): Promise<boolean> {
  const sleep = dependencies.sleep ?? delay;
  let launched = false;
  while (true) {
    const browsers = await listBrowsers(run, {
      timeoutMs: Math.min(60_000, remaining()),
      env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    const browser = browsers.find((item) => item.instance_id === account.instanceId);
    if (browser) {
      if (!isEdge(browser)) throw new ZenxError("NOT_EDGE", "目标实例不是 Microsoft Edge；不会改选其他浏览器。");
      if (!protocolSupported(browser)) throw new ZenxError("UNSUPPORTED_PROTOCOL", "目标扩展协议不兼容；当前仅支持 1.0 / 1.1 / 1.3。");
      return launched;
    }
    if (!launched) {
      if (!account.launch) throw new ZenxError("LAUNCH_NOT_CONFIGURED", "目标实例离线且尚未配置启动路径；请明确配置既有 Edge Profile 后重试。");
      if ((dependencies.platform ?? process.platform) !== "win32") throw new ZenxError("UNSUPPORTED_PLATFORM", "按需启动目前仅支持 Windows；不会启动其他平台浏览器。");
      await validatePaths(account.launch);
      await rejectSharedProfile(store, account.alias, account.launch);
      remaining();
      try { await (dependencies.launch ?? launchEdge)({ ...account.launch }); }
      catch { throw new ZenxError("EDGE_LAUNCH_FAILED", "无法启动已配置的 Edge；请检查可执行文件和系统权限，不会重复启动。"); }
      launched = true;
      remaining();
    } else {
      await sleep(Math.min(500, remaining()));
    }
  }
}

export async function ensureOnline(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 45_000,
  dependencies: LaunchDependencies = {},
): Promise<{ ok: true; alias: string; instanceId: string; connection: "online"; launched: boolean; identity: "not_verified" }> {
  const remaining = deadlineBudget(timeoutMs, dependencies);
  return withStoreLock(home, async () => {
    const store = await readStore(home);
    const account = findAccount(store, alias);
    const launched = await ensureOnlineLocked(store, account, run, remaining, dependencies);
    return { ok: true, alias: account.alias, instanceId: account.instanceId, connection: "online", launched, identity: "not_verified" };
  });
}

function parseCloseReply(raw: string, instanceId: string): {
  browser_id: string;
  closed: boolean;
  windows_closed: number;
  sessions_stopped: number;
  disconnected: boolean;
} {
  let value: unknown;
  try { value = JSON.parse(raw); }
  // 关闭可能已经生效：解析失败只报告"无法确认"，绝不重试、绝不改选实例。
  catch { throw new ZenxError("INVALID_BSK_OUTPUT", "bsk 未返回有效 JSON；关闭可能已生效，不会重试，请用 zenx accounts check 确认。"); }
  if (typeof value !== "object" || value === null) throw new ZenxError("INVALID_BSK_OUTPUT", "bsk 关闭结果不是对象；关闭可能已生效，不会重试。");
  const result = value as { browser_id?: unknown; closed?: unknown; windows_closed?: unknown; sessions_stopped?: unknown; disconnected?: unknown };
  if (result.browser_id !== instanceId || typeof result.closed !== "boolean" || typeof result.disconnected !== "boolean" ||
    !Number.isSafeInteger(result.windows_closed) || !Number.isSafeInteger(result.sessions_stopped)) {
    throw new ZenxError("INVALID_BSK_OUTPUT", "bsk 关闭结果字段异常或未回显目标实例；关闭可能已生效，不会重试，请用 zenx accounts check 确认。");
  }
  return {
    browser_id: instanceId,
    closed: result.closed,
    windows_closed: result.windows_closed as number,
    sessions_stopped: result.sessions_stopped as number,
    disconnected: result.disconnected,
  };
}

/**
 * 与 ensure-online 成对：关闭账号绑定的那个 Edge 实例（停止其全部会话后关闭
 * 所有窗口，浏览器进程随之退出）。
 *
 * 安全措施：
 * - 只用账号里已绑定的精确 instanceId；不按标签/前缀匹配，离线直接报错，不会改选。
 * - 调用前先确认该实例在线且是协议兼容的 Edge，避免关到别的浏览器。
 * - bsk 侧要求 --confirm，本命令同样要求调用方已确认（CLI 层强制 --confirm）。
 * - 失败一律不重试、不杀进程：关闭可能已生效，报告"无法确认"交给人工核对。
 */
export async function closeBrowser(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 45_000,
  dependencies: LaunchDependencies = {},
): Promise<{
  ok: true;
  alias: string;
  instanceId: string;
  browser_id: string;
  closed: boolean;
  windows_closed: number;
  sessions_stopped: number;
  disconnected: boolean;
  identity: "not_verified";
}> {
  const remaining = deadlineBudget(timeoutMs, dependencies);
  const store = await readStore(home);
  const account = findAccount(store, alias);
  let result: CloseReply;
  try {
    result = await closeOnlineInstance(run, account.instanceId, remaining, account.alias);
  } catch (error) {
    // 失败也要如实回写追踪：离线 = 无可关，记录清除；其他失败 = 留下原因，close-leftover 还会再试。
    if (error instanceof ZenxError && error.code === "INSTANCE_OFFLINE") {
      await clearLaunchedInstance(home, account.alias, account.instanceId);
    } else {
      const message = error instanceof ZenxError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "关闭失败。";
      await markLeftoverCloseError(home, account.alias, account.instanceId, message);
    }
    throw error;
  }
  // 关闭确认后顺带清掉遗留追踪（若这个实例是 zenx 之前拉起的）。
  await clearLaunchedInstance(home, account.alias, account.instanceId);
  return { ok: true, alias: account.alias, instanceId: account.instanceId, ...result, identity: "not_verified" };
}

type CloseReply = {
  browser_id: string;
  closed: boolean;
  windows_closed: number;
  sessions_stopped: number;
  disconnected: boolean;
};

/** closeBrowser 与 closeInstanceById 共用的关闭体：在线与兼容性检查 + 一次 close 调用。 */
async function closeOnlineInstance(run: Runner, instanceId: string, remaining: () => number, alias?: string): Promise<CloseReply> {
  const browsers = await listBrowsers(run, {
    timeoutMs: Math.min(60_000, remaining()),
    env: { BSK_BROWSER_WAIT_MS: "0" },
  });
  remaining();
  const browser = browsers.find((item) => item.instance_id === instanceId);
  if (!browser) throw new ZenxError("INSTANCE_OFFLINE", "目标实例未在线：没有可关闭的 Edge；未调用关闭，也不会改选其他实例。", alias ? { alias } : undefined);
  if (!isEdge(browser)) throw new ZenxError("NOT_EDGE", "目标实例不是 Microsoft Edge；不会关闭。");
  if (!protocolSupported(browser)) throw new ZenxError("UNSUPPORTED_PROTOCOL", "目标扩展协议不兼容；当前仅支持 1.0 / 1.1 / 1.3，不会关闭。");
  remaining();
  const reply = await run(
    ["browsers", "close", "--browser-id", instanceId, "--confirm", "--json"],
    { timeoutMs: Math.min(60_000, remaining()) },
  );
  if (reply.exitCode !== 0) {
    const detail = reply.stdout.trim().slice(0, 200);
    // 扩展不认识这个方法：要么是旧构建，要么是 daemon 还留着换构建之前的旧注册
    // （此时 bsk browsers 的 EXT 列仍旧版本号，新方法一概被当成 unknown_method）。
    // 分开报，别笼统说"bsk 失败"——两者的下一步完全不同。
    if (/unknown_method|not implemented/i.test(reply.stdout)) {
      throw new ZenxError(
        "CLOSE_NOT_SUPPORTED",
        "该实例的扩展未实现 browser.close；未关闭任何窗口。",
        { ...(alias ? { alias } : {}), ...(detail ? { detail } : {}) },
      );
    }
    throw new ZenxError("BSK_FAILED", "bsk 未能确认浏览器已关闭；关闭可能已生效，不会自动重试，请用 zenx accounts check 核对。", detail ? { detail } : undefined);
  }
  return parseCloseReply(reply.stdout, instanceId);
}

/**
 * 按精确实例 ID 关闭（不要求它绑定在任何账号上）。供 close-leftover 使用：
 * 遗留记录里的实例可能已不在绑定关系里，但它确实是 zenx 拉起的。
 * 安全措施与 closeBrowser 相同：只认精确 ID，离线/非 Edge/协议不符直接报错，不改选。
 */
export async function closeInstanceById(
  run: Runner,
  instanceId: string,
  timeoutMs: number = 45_000,
  dependencies: LaunchDependencies = {},
): Promise<CloseReply & { ok: true }> {
  const remaining = deadlineBudget(timeoutMs, dependencies);
  const result = await closeOnlineInstance(run, instanceId, remaining);
  return { ok: true, ...result };
}

export type CloseAllOutcome = {
  alias: string;
  instanceId: string;
  status: "closed" | "offline" | "failed";
  windowsClosed?: number;
  sessionsStopped?: number;
  code?: string;
  message?: string;
};

/**
 * 逐个关闭全部绑定账号的 Edge 实例（zenx accounts close-all）。
 *
 * 与批量签到末尾的释放不同，这是用户显式发起的清仓：不管实例是不是本轮拉起的。
 * 单个失败（旧扩展不认识 browser.close、bsk 未确认等）不中断后续账号，
 * 全部如实汇总；离线的跳过并顺带清掉它的遗留追踪记录。
 */
export async function closeAllBrowsers(
  home: string,
  run: Runner,
  timeoutMs: number = 45_000,
  dependencies: LaunchDependencies = {},
  onProgress: (line: string) => void = () => undefined,
): Promise<{ ok: boolean; total: number; closed: number; offline: number; failed: number; accounts: CloseAllOutcome[] }> {
  const store = await readStore(home);
  const accounts: CloseAllOutcome[] = [];
  for (const account of store.accounts) {
    try {
      const reply = await closeBrowser(home, run, account.alias, timeoutMs, dependencies);
      if (reply.disconnected) {
        accounts.push({ alias: account.alias, instanceId: account.instanceId, status: "closed", windowsClosed: reply.windows_closed, sessionsStopped: reply.sessions_stopped });
        onProgress(`${account.alias}: 已关闭（窗口 ${reply.windows_closed}，会话 ${reply.sessions_stopped}）`);
      } else {
        accounts.push({ alias: account.alias, instanceId: account.instanceId, status: "failed", code: "STILL_CONNECTED", message: "实例仍处于连接状态；未关闭。" });
        onProgress(`${account.alias}: 关闭未确认（实例仍在线）`);
      }
    } catch (error) {
      // 离线/失败的追踪回写已在 closeBrowser 内完成，这里只汇总。
      if (error instanceof ZenxError && error.code === "INSTANCE_OFFLINE") {
        accounts.push({ alias: account.alias, instanceId: account.instanceId, status: "offline" });
        onProgress(`${account.alias}: 实例不在线，无需关闭`);
        continue;
      }
      const code = error instanceof ZenxError ? error.code : "COMMAND_FAILED";
      const message = error instanceof Error ? error.message : "关闭失败。";
      accounts.push({ alias: account.alias, instanceId: account.instanceId, status: "failed", code, message });
      onProgress(`${account.alias}: 关闭失败（${code}: ${message}）`);
    }
  }
  const closed = accounts.filter((item) => item.status === "closed").length;
  const offline = accounts.filter((item) => item.status === "offline").length;
  const failed = accounts.filter((item) => item.status === "failed").length;
  return { ok: failed === 0, total: accounts.length, closed, offline, failed, accounts };
}

export type LeftoverOutcome = {
  alias: string;
  instanceId: string;
  status: "closed" | "offline" | "rebound" | "failed";
  code?: string;
  message?: string;
};

/**
 * 关闭遗留追踪里"zenx 拉起但没关掉"的实例（zenx accounts close-leftover）。
 *
 * 每条记录三种归宿：
 * - 实例还在线 → 按记录里的精确 ID 关闭，确认后移除记录；
 * - 实例已离线 → 没什么可关的，直接移除记录（dropped）；
 * - 实例 ID 已改绑给其他账号 → 它不再是无主遗留，绝不动它，只移除记录（rebound）。
 * 关闭失败（如旧扩展不认识 browser.close）保留记录并写上原因，下次还会再试。
 */
export async function closeLeftoverInstances(
  home: string,
  run: Runner,
  timeoutMs: number = 45_000,
  dependencies: LaunchDependencies = {},
  onProgress: (line: string) => void = () => undefined,
): Promise<{ ok: boolean; tracked: number; closed: number; dropped: number; failed: number; instances: LeftoverOutcome[] }> {
  const state = await readLeftovers(home);
  const store = await readStore(home);
  const instances: LeftoverOutcome[] = [];
  for (const entry of state.instances) {
    const bound = store.accounts.find((account) => account.instanceId === entry.instanceId);
    if (bound && bound.alias !== entry.alias) {
      await clearLaunchedInstance(home, entry.alias, entry.instanceId);
      instances.push({ alias: entry.alias, instanceId: entry.instanceId, status: "rebound" });
      onProgress(`${entry.alias}: 实例已改绑给 ${bound.alias}，跳过并移除记录`);
      continue;
    }
    try {
      const reply = await closeInstanceById(run, entry.instanceId, timeoutMs, dependencies);
      if (reply.disconnected) {
        await clearLaunchedInstance(home, entry.alias, entry.instanceId);
        instances.push({ alias: entry.alias, instanceId: entry.instanceId, status: "closed" });
        onProgress(`${entry.alias}: 遗留实例已关闭（窗口 ${reply.windows_closed}，会话 ${reply.sessions_stopped}）`);
      } else {
        await markLeftoverCloseError(home, entry.alias, entry.instanceId, "实例仍处于连接状态；未关闭。");
        instances.push({ alias: entry.alias, instanceId: entry.instanceId, status: "failed", code: "STILL_CONNECTED", message: "实例仍处于连接状态；未关闭。" });
        onProgress(`${entry.alias}: 遗留实例关闭未确认（仍在线）`);
      }
    } catch (error) {
      if (error instanceof ZenxError && error.code === "INSTANCE_OFFLINE") {
        await clearLaunchedInstance(home, entry.alias, entry.instanceId);
        instances.push({ alias: entry.alias, instanceId: entry.instanceId, status: "offline" });
        onProgress(`${entry.alias}: 遗留实例已不在线，移除记录`);
        continue;
      }
      const code = error instanceof ZenxError ? error.code : "COMMAND_FAILED";
      const message = error instanceof Error ? error.message : "关闭失败。";
      await markLeftoverCloseError(home, entry.alias, entry.instanceId, `${code}: ${message}`);
      instances.push({ alias: entry.alias, instanceId: entry.instanceId, status: "failed", code, message });
      onProgress(`${entry.alias}: 遗留实例关闭失败（${code}: ${message}）`);
    }
  }
  const closed = instances.filter((item) => item.status === "closed").length;
  const failed = instances.filter((item) => item.status === "failed").length;
  return { ok: failed === 0, tracked: state.instances.length, closed, dropped: instances.length - closed - failed, failed, instances };
}

export async function openSite(
  home: string,
  run: Runner,
  alias: string,
  tabId?: number,
  timeoutMs: number = 45_000,
  dependencies: LaunchDependencies = {},
) {
  if (tabId !== undefined && !isTabId(tabId)) throw new ZenxError("INVALID_TAB_ID", "--tab-id 必须是 1–2147483647 的十进制整数。");
  const remaining = deadlineBudget(timeoutMs, dependencies, true);
  return withStoreLock(home, async () => {
    const store = await readStore(home);
    const account = findAccount(store, alias);
    const launched = await ensureOnlineLocked(store, account, run, remaining, dependencies);
    const result = await openAgentRouter(run, account.instanceId, tabId, remaining, account.alias);
    return { ok: true, alias: account.alias, instanceId: account.instanceId, ...result, identity: "not_verified", launched };
  });
}

/**
 * 按账号锚点重新定位实例。
 *
 * Edge 重启后扩展实例 ID 会变，账号里存的旧 ID 随之失效。本命令不依赖会被
 * 用户改名、还会重名的「Profile 显示名」，而用两路锚点比对：
 *
 * 1. **bsk 直报**（需 fork 构建 + 扩展开关打开）：`bsk browsers` 的
 *    `profile_account_id`，直接和账号记录的锚点比对，零探测、不开窗口。
 * 2. **Preferences 回退**（当前 bsk 0.2.3 走的这条路）：给每个候选实例开一个
 *    隔离窗口，用窗口标题的 Profile 标记确定它属于哪个 Profile 子目录，再读该目录
 *    的 `account_info.account_id` 与锚点比对。判定依据是**账号 ID 而不是显示名**，
 *    因此 Default 显示为 `3`、Profile 3 显示为 `916938 13` 这类改名不再致命。
 *
 * 安全措施：
 * - 必须 --confirm，且账号必须先配置 launch 并已记录锚点。
 * - 锚点在候选里必须唯一；多个实例同锚点时拒绝改绑。
 * - 不启动、不关闭任何 Edge，只读取窗口标题与只读 JSON。
 */
export async function relinkAccount(
  home: string,
  run: Runner,
  alias: string,
  timeoutMs: number = 120_000,
  dependencies: LaunchDependencies = {},
): Promise<{
  ok: true;
  alias: string;
  profileDirectory: string;
  profileAccountId: string;
  previousInstanceId: string;
  instanceId: string;
  changed: boolean;
  /** 判定依据：bsk 直报账号 ID，还是回退到标题+Preferences 推导。 */
  method: "bsk" | "preferences";
}> {
  const remaining = deadlineBudget(timeoutMs, dependencies);
  const sleep = dependencies.sleep ?? delay;
  const listTitles = dependencies.listWindowTitles ?? listEdgeWindowTitles;
  const detect = dependencies.detectProfile ?? detectProfile;
  const readAnchor = dependencies.readProfileAccount ?? readProfileAccount;

  return updateStore(home, async (store) => {
    const account = findAccount(store, alias);
    if (!account.launch) {
      throw new ZenxError("LAUNCH_NOT_CONFIGURED", "该账号尚未配置启动路径；无法读取 Profile 的账号锚点。请先用 configure-launch 配置。");
    }
    // 优先重新读取（账号可能被换掉），读不到才回退已记录的锚点；两者都没有才报错。
    const fresh = await readAnchor(account.launch.userDataDir, account.launch.profileDirectory);
    const anchor = fresh.accountId || account.profileAccountId?.trim() || "";
    if (!anchor) {
      throw new ZenxError("ACCOUNT_ANCHOR_MISSING", "未能从该 Profile 的 Preferences 读到已登录账号 ID；请确认该 Profile 已登录 Edge，且 ZenX 有权限读取用户数据目录。");
    }
    const browsers = await listBrowsers(run, {
      timeoutMs: Math.min(60_000, remaining()),
      env: { BSK_BROWSER_WAIT_MS: "0" },
    });
    remaining();
    const candidates = browsers.filter((item) => isEdge(item) && protocolSupported(item));
    if (candidates.length === 0) throw new ZenxError("NO_EDGE_CONNECTED", "当前没有在线且兼容的 Edge 实例；请先启动目标 Profile 的 Edge。");

    // 1) bsk 直报：无需开窗口，命中即返回。
    const direct = candidates.filter((item) => item.profile_account_id?.toLowerCase() === anchor);
    if (direct.length === 1) return commit(store, account, direct[0].instance_id, anchor, "bsk");
    if (direct.length > 1) {
      throw new ZenxError("PROFILE_AMBIGUOUS", `有 ${direct.length} 个在线实例直报该账号 ID（${direct.map((item) => item.instance_id).join(", ")}）；无法判定，未改绑。`);
    }

    // 2) 回退：逐个候选开隔离窗口，用标题标记确定它属于哪个 Profile 子目录，
    //    再读该目录的 account_id 与锚点比对。
    const matched: string[] = [];
    for (const browser of candidates) {
      // 已指向自己的实例直接认定匹配，无需开窗口探测。
      if (browser.instance_id === account.instanceId) { matched.push(browser.instance_id); continue; }
      const before = await listTitles();
      const startReply = await run(
        ["session", "start", "--browser-id", browser.instance_id, "--width", "1280", "--height", "800", "--json"],
        { timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" } },
      );
      remaining();
      if (startReply.exitCode !== 0) continue;
      let sessionId = "";
      try { sessionId = parseSessionStart(startReply.stdout); } catch { continue; }
      try {
        // 窗口挂载需要时间，轮询等待而非固定 sleep；次数必须有上限，
        // 若时间源停滞（注入的 now 不动），只靠 deadline 会变成死循环。
        let marker: string | null = null;
        for (let attempt = 0; attempt < PROFILE_PROBE_ATTEMPTS; attempt++) {
          marker = await detect(before, account.launch.profileDirectory);
          if (marker) break;
          if (attempt > 0) await sleep(Math.min(PROFILE_PROBE_INTERVAL_MS, remaining()));
        }
        if (marker) matched.push(browser.instance_id);
      } finally {
        // 探测用的窗口必须回收，否则会在桌面留下空白 Edge 窗口。
        await run(["session", "stop", sessionId], { timeoutMs: 30_000 }).catch(() => undefined);
      }
    }

    if (matched.length === 0) {
      throw new ZenxError("PROFILE_NOT_FOUND", `没有在线实例属于 Profile「${account.launch.profileDirectory}」；请确认该 Profile 的 Edge 已启动且扩展已连接。`, { alias: account.alias });
    }
    if (matched.length > 1) {
      throw new ZenxError("PROFILE_AMBIGUOUS", `有 ${matched.length} 个在线实例都指向 Profile「${account.launch.profileDirectory}」（${matched.join(", ")}）；无法判定，未改绑。`);
    }
    return commit(store, account, matched[0], anchor, "preferences");
  });
}

function commit(
  store: Store,
  account: Account,
  instanceId: string,
  profileAccountId: string,
  method: "bsk" | "preferences",
) {
  const changed = instanceId !== account.instanceId;
  const previousInstanceId = account.instanceId;
  account.instanceId = instanceId;
  account.profileAccountId = profileAccountId;
  account.profileAccountSource = method === "bsk" ? "bsk" : account.profileAccountSource ?? "preferences";
  return {
    ok: true as const,
    alias: account.alias,
    profileDirectory: account.launch?.profileDirectory ?? "",
    profileAccountId,
    previousInstanceId,
    instanceId,
    changed,
    method,
  };
}

// 只读预检：不启动 Edge、不持账号锁、不切换/新建/刷新标签；离线直接报告，不等待。
export async function inspectSite(
  home: string,
  run: Runner,
  alias: string,
  tabId?: number,
  timeoutMs: number = 45_000,
  dependencies: LaunchDependencies = {},
) {
  if (tabId !== undefined && !isTabId(tabId)) throw new ZenxError("INVALID_TAB_ID", "--tab-id 必须是 1–2147483647 的十进制整数。");
  const remaining = deadlineBudget(timeoutMs, dependencies, true);
  const store = await readStore(home);
  const account = findAccount(store, alias);
  const browsers = await listBrowsers(run, {
    timeoutMs: Math.min(60_000, remaining()),
    env: { BSK_BROWSER_WAIT_MS: "0" },
  });
  remaining();
  const browser = browsers.find((item) => item.instance_id === account.instanceId);
  const connection = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";
  if (connection !== "online") {
    return { ok: false, alias: account.alias, instanceId: account.instanceId, connection, siteTab: null, identity: "not_verified" };
  }
  const result = await inspectAgentRouter(run, account.instanceId, account.expectedIdentity, tabId, remaining, account.alias);
  return { ok: true, alias: account.alias, instanceId: account.instanceId, connection, ...result, identity: result.observation?.identity ?? "not_verified" };
}
