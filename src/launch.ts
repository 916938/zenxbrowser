import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isEdge, listBrowsers, protocolSupported, readStore, updateStore, withStoreLock, ZenxError } from "./core.ts";
import type { Account, Runner, Store } from "./core.ts";
import { isLaunchConfig } from "./launch-config.ts";
import { isTabId, inspectAgentRouter, openAgentRouter } from "./site.ts";
import type { LaunchConfig } from "./launch-config.ts";

export type { LaunchConfig } from "./launch-config.ts";
export type LaunchDependencies = {
  launch?: (config: LaunchConfig) => Promise<void>;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function findAccount(store: Store, alias: string): Account {
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
    return account;
  });
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
    const result = await openAgentRouter(run, account.instanceId, tabId, remaining);
    return { ok: true, alias: account.alias, instanceId: account.instanceId, ...result, identity: "not_verified", launched };
  });
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
  const result = await inspectAgentRouter(run, account.instanceId, account.expectedIdentity, tabId, remaining);
  return { ok: true, alias: account.alias, instanceId: account.instanceId, connection, ...result, identity: result.observation?.identity ?? "not_verified" };
}
