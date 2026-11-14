/**
 * 「实例离线就自动拉起」的统一编排，供 snapshot / recheck 这类只读命令共用。
 *
 * 为什么单独一层：这些命令过去都只丢一句"实例离线；先执行 ensure-online"，把
 * 打开浏览器变成人工前置步骤。而拉起/回收有一整套不能走样的约束——
 * - ensureOnline 自己持账号锁，调用方必须在 withStoreLock **之外**用它，否则 STORE_BUSY；
 * - 拉起最贵（一个 Edge Profile 几百 MB），只在真离线且已配置 launch 时才做；
 * - 采完只关本轮自己拉起的实例，用户本来开着的 Edge 一律不动；
 * - 连接超时时 ensureOnline 只抛错拿不到返回值，所以拉起事实要在返回**之前**落盘，
 *   事后 close-leftover 才认得出这个窗口是 zenx 的。
 *
 * 两个命令共用这份实现，行为与错误提示才不会各自漂移。
 */

import { isEdge, listBrowsers, protocolSupported, ZenxError } from "./core.ts";
import type { Account, Browser, Runner } from "./core.ts";
import { closeBrowser, ensureOnline } from "./launch.ts";
import type { LaunchDependencies } from "./launch.ts";
import { recordLaunchedInstance } from "./leftover.ts";

export type Connection = "online" | "offline" | "wrong_browser" | "unsupported_protocol";
export type LaunchFailure = { code: string; message: string; hint?: string };

export type AutoOnlineOptions = {
  /** 实例离线时自动拉起已配置的 Edge Profile（默认 true）；false 保持纯只读。 */
  ensureOnline?: boolean;
  /** 保留自动拉起的窗口（默认 false：用完即关，压住内存峰值）。 */
  keepOpen?: boolean;
  /** 拉起/关闭的依赖注入（测试替身）。 */
  launchDependencies?: LaunchDependencies;
  onProgress?: (line: string) => void;
  /** ensureOnline 的等待预算（默认 45s），与采集预算分开算。 */
  timeoutMs?: number;
};

export type OnlineSession = {
  connection: Connection;
  /** 该账号的 Edge 是否由本次命令拉起。 */
  launched: boolean;
  /** 连接不可用时写进报告的错误码（具体拉起失败原因优先于笼统的 OFFLINE）。 */
  errorCode: string;
  note: string;
  hint?: string;
  /** 收尾：只关自己拉起的实例。无论采集成败都要调用（放在 finally 里）。 */
  finish: () => Promise<{ closed?: boolean; closureError?: string }>;
};

/** 采完后单次关闭（含离线复核）的预算。 */
const RELEASE_TIMEOUT_MS = 45_000;
const LIST_OPTIONS = { timeoutMs: 60_000, env: { BSK_BROWSER_WAIT_MS: "0" } };

export function connectionOf(browser: Browser | undefined): Connection {
  return !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";
}

/**
 * 离线/不兼容时把「下一步该做什么」写进 note：原来是"实例离线；先执行
 * ensure-online"，用户还得自己猜是没开浏览器、没配启动路径，还是扩展版本不对。
 */
export function unreachableNote(alias: string, connection: Connection, auto: boolean, failure?: LaunchFailure): string {
  if (connection === "wrong_browser") return "实例不是 Microsoft Edge；未读取站点。用 bsk browsers 核对实例类型。";
  if (connection === "unsupported_protocol") return "扩展协议不兼容；未读取站点。把 bsk CLI、daemon 和扩展一起升级到匹配版本。";
  if (failure?.code === "LAUNCH_NOT_CONFIGURED") {
    return `实例离线且该账号未配置启动路径，无法自动拉起；未读取站点。先跑 zenx accounts configure-launch ${alias} --edge-path <msedge.exe> --user-data-dir <用户数据根目录> --profile-directory <Profile子目录> --confirm，或手工打开该 Profile 的 Edge。`;
  }
  if (failure) {
    // 扩展换构建/Edge 重启后实例 ID 会变，等连接等到超时的真实成因往往是它。
    const relink = failure.code === "PROFILE_CONNECT_TIMEOUT"
      ? ` 若 Edge 重启或扩展更新过导致实例 ID 变化，先跑 zenx accounts relink-account ${alias} --confirm 重新定位。` : "";
    return `实例离线，自动拉起失败（${failure.code}: ${failure.message}）；未读取站点。${failure.hint ?? ""}${relink}`.trim();
  }
  if (!auto) return "实例离线：已按 --ensure-online no 保持只读；未读取站点。去掉该参数即可自动拉起。";
  return "实例离线；未读取站点。";
}

/** 关闭结论只认复核后的离线；失败留原因，交给 close-leftover 兜底。 */
async function releaseLaunched(
  home: string,
  run: Runner,
  alias: string,
  launchDependencies: LaunchDependencies | undefined,
  onProgress: (line: string) => void,
): Promise<{ closed: boolean; error?: string }> {
  try {
    const reply = await closeBrowser(home, run, alias, RELEASE_TIMEOUT_MS, launchDependencies);
    if (reply.outcome.instanceOffline) return { closed: true };
    return { closed: false, error: "关闭请求已响应，但复核时实例仍在注册表；未确认释放。" };
  } catch (error) {
    const code = error instanceof ZenxError ? error.code : "COMMAND_FAILED";
    const message = error instanceof Error ? error.message : "关闭失败。";
    onProgress(`${alias}: 自动拉起的实例未能关闭（${code}: ${message}）；可用 zenx accounts close-leftover --confirm 兜底`);
    return { closed: false, error: `${code}: ${message}` };
  }
}

/**
 * 连接判定 + 离线按需拉起。必须在调用方的 withStoreLock **之外**执行。
 * 返回的 finish() 由调用方放在 finally 里，保证异常路径也回收浏览器。
 */
export async function prepareOnline(
  home: string,
  run: Runner,
  account: Account,
  options: AutoOnlineOptions = {},
): Promise<OnlineSession> {
  const alias = account.alias;
  const auto = options.ensureOnline ?? true;
  const keepOpen = options.keepOpen ?? false;
  const progress = options.onProgress ?? (() => undefined);

  let browsers = await listBrowsers(run, LIST_OPTIONS);
  let browser = browsers.find((item) => item.instance_id === account.instanceId);
  let launched = false;
  let failure: LaunchFailure | undefined;
  if (!browser && auto) {
    if (!account.launch) {
      failure = {
        code: "LAUNCH_NOT_CONFIGURED",
        message: "该账号尚未配置启动路径。",
        hint: `先跑 zenx accounts configure-launch ${alias} --edge-path <msedge.exe> --user-data-dir <用户数据根目录> --profile-directory <Profile子目录> --confirm。`,
      };
    } else {
      // 拉起事实要在 ensureOnline 返回前登记：连接超时时它只抛错，拿不到返回值，
      // 那个已拉起的 Edge 会被当成"用户自己的"永远留着。
      const launchDependencies: LaunchDependencies = {
        ...options.launchDependencies,
        onLaunched: async (instanceId) => {
          await options.launchDependencies?.onLaunched?.(instanceId);
          await recordLaunchedInstance(home, alias, instanceId);
        },
      };
      try {
        const online = await ensureOnline(home, run, alias, options.timeoutMs ?? 45_000, launchDependencies);
        launched = online.launched;
        if (launched) {
          await recordLaunchedInstance(home, alias, online.instanceId);
          progress(`${alias}: 实例离线，已自动拉起 Edge`);
        }
        browsers = await listBrowsers(run, LIST_OPTIONS);
        browser = browsers.find((item) => item.instance_id === account.instanceId);
      } catch (error) {
        failure = {
          code: error instanceof ZenxError ? error.code : "COMMAND_FAILED",
          message: error instanceof Error ? error.message : "自动拉起失败。",
          ...(error instanceof ZenxError && error.hint ? { hint: error.hint } : {}),
        };
        progress(`${alias}: 自动拉起失败（${failure.code}）`);
      }
    }
  }
  const connection = connectionOf(browser);
  let finished = false;
  return {
    connection,
    launched,
    errorCode: connection === "offline" && failure && failure.code !== "LAUNCH_NOT_CONFIGURED"
      ? failure.code : connection.toUpperCase(),
    note: unreachableNote(alias, connection, auto, failure),
    ...(failure?.hint ? { hint: failure.hint } : {}),
    finish: async () => {
      if (finished) return {};
      finished = true;
      if (!launched || keepOpen) return {};
      const release = await releaseLaunched(home, run, alias, options.launchDependencies, progress);
      if (release.closed) progress(`${alias}: 已关闭本次拉起的 Edge`);
      return { closed: release.closed, ...(release.error ? { closureError: release.error } : {}) };
    },
  };
}
