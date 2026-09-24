import { listBrowsers, readStore, ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";

/**
 * BSK_TIMEOUT 的"卡死实例"诊断。
 *
 * 裸的 BSK_TIMEOUT 只说"bsk 调用超时"，但两种常见根因的下一步完全不同：
 * - 实例能列出、session 调用却挂住 → 该 Profile 的扩展/daemon 连接卡死，
 *   要关掉那个 Edge 窗口（遗留卡死实例不处理的话，每次运行都会在同一处超时）；
 * - 连 bsk browsers 都挂住 → daemon 本身卡死，要重启 daemon。
 * 超时已经发生在错误路径上，多花一次短预算（10s）的列举换一条可执行的诊断，值得。
 */

const MARKER = "诊断：";

async function diagnose(run: Runner, instanceId?: string): Promise<string> {
  let browsers;
  try {
    browsers = await listBrowsers(run, { timeoutMs: 10_000, env: { BSK_BROWSER_WAIT_MS: "0" } });
  } catch {
    return "连 bsk browsers 都无响应，bsk daemon 疑似卡死：执行 bsk daemon restart 后重试。";
  }
  if (instanceId && browsers.some((item) => item.instance_id === instanceId)) {
    return "目标实例仍能列出但操作无响应，该 Profile 的扩展疑似卡死：手动关闭该 Edge 窗口（或 zenx accounts close <别名> --confirm），必要时 bsk daemon restart，然后重试；不处理的话每次运行都会在同一处超时。";
  }
  return "目标实例当前不在连接列表中（可能已退出或实例 ID 已变化）：重跑时会重新拉起；若反复出现，检查该 Profile 的扩展是否被禁用，或用 zenx accounts relink-account <别名> --confirm 改绑。";
}

/**
 * 是 BSK_TIMEOUT 就追加诊断信息后重新抛出（返回新错误），其他错误原样返回。
 * 已含诊断标记的错误不再重复追加（批量与单账号两条路径都可能经过这里）。
 */
export async function enrichBskTimeout(
  error: unknown,
  run: Runner,
  context: { home?: string; alias?: string; instanceId?: string } = {},
): Promise<unknown> {
  if (!(error instanceof ZenxError) || error.code !== "BSK_TIMEOUT" || error.message.includes(MARKER)) return error;
  let instanceId = context.instanceId;
  if (!instanceId && context.home && context.alias) {
    try {
      instanceId = (await readStore(context.home)).accounts.find((account) => account.alias === context.alias)?.instanceId;
    } catch {
      // 读不到绑定就用不了实例维度诊断，退化为通用诊断。
    }
  }
  return new ZenxError("BSK_TIMEOUT", `${error.message}${MARKER}${await diagnose(run, instanceId)}`);
}
