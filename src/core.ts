import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isLaunchConfig } from "./launch-config.ts";
import type { LaunchConfig } from "./launch-config.ts";
import { hintFor } from "./hints.ts";

export class ZenxError extends Error {
  code: string;
  details?: Record<string, unknown>;
  /**
   * 可执行的下一步建议。构造时留空则由错误码 + details 合成
   * （见 hints.ts）；抛出点也可以直接给，用于覆盖默认建议。
   */
  hint?: string;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
    this.hint = hintFor(this) ?? undefined;
  }
}

export type Result = { stdout: string; exitCode: number };
export type RunnerOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv };
export type Runner = (args: string[], options?: RunnerOptions) => Promise<Result>;
export type Browser = {
  instance_id: string;
  browser_name: string;
  browser_version: string;
  extension_version: string;
  label: string;
  extension_protocol_version: string;
  version_skew: boolean;
  /**
   * 浏览器 Profile 已登录账号的不透明 ID（fork 构建 + 扩展开关打开后才有）。
   * 旧版 bsk 没有这个字段，这里按缺省空串处理，便于按账号锚点定位时降级。
   */
  profile_account_id?: string;
};
export type Account = {
  alias: string;
  instanceId: string;
  expectedIdentity: string;
  boundAt: string;
  launch?: LaunchConfig;
  /** 绑定时记录的账号锚点，供实例 ID 变化后按账号重新定位。 */
  profileAccountId?: string;
  /** 锚点采集来源，便于判断可信度。 */
  profileAccountSource?: "preferences" | "bsk" | "manual";
};
export type Store = { version: 1; accounts: Account[] };

export function createRunner(executable = "bsk"): Runner {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const timeout = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(timeout) || timeout < 1) {
      reject(new ZenxError("INVALID_TIMEOUT", "bsk 调用预算必须为至少 1 毫秒的有限数值。"));
      return;
    }
    execFile(executable, args, {
      shell: false,
      windowsHide: true,
      timeout: Math.min(Math.floor(timeout), 60_000),
      env: { ...process.env, ...options.env },
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout) => {
      if (error?.killed) {
        reject(new ZenxError("BSK_TIMEOUT", "bsk 调用超时，已终止本次子进程；远端操作可能已生效，不会自动重试。"));
        return;
      }
      if (error && typeof error.code !== "number") {
        reject(new ZenxError("BSK_UNAVAILABLE", "无法启动 bsk；检查 ZENX_BSK_PATH 和本地安装。"));
        return;
      }
      resolve({ stdout, exitCode: typeof error?.code === "number" ? error.code : 0 });
    });
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function json(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new ZenxError("INVALID_BSK_OUTPUT", "bsk 未返回有效 JSON；未进行账号操作。使用 zenx doctor 检查环境。"); }
}

export function parseBrowsers(raw: string): Browser[] {
  const value = json(raw);
  if (!Array.isArray(value)) throw new ZenxError("INVALID_BSK_OUTPUT", "bsk browsers 必须返回顶层数组。");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!object(item) || !["instance_id", "browser_name", "browser_version", "extension_version"].every((key) => text(item[key])) ||
      typeof item.label !== "string" || typeof item.extension_protocol_version !== "string" || typeof item.version_skew !== "boolean") {
      throw new ZenxError("INVALID_BSK_OUTPUT", "浏览器列表缺少所需字段；请更新 bsk 和扩展。");
    }
    if (item.profile_account_id !== undefined && typeof item.profile_account_id !== "string") {
      throw new ZenxError("INVALID_BSK_OUTPUT", "浏览器列表的账号 ID 字段类型异常；请更新 bsk 和扩展。");
    }
    if (ids.has(item.instance_id as string)) throw new ZenxError("DUPLICATE_INSTANCE", "浏览器列表包含重复实例 ID；停止绑定。");
    ids.add(item.instance_id as string);
    return {
      instance_id: item.instance_id as string,
      browser_name: item.browser_name as string,
      browser_version: item.browser_version as string,
      extension_version: item.extension_version as string,
      label: item.label,
      extension_protocol_version: item.extension_protocol_version,
      version_skew: item.version_skew,
      profile_account_id: (item.profile_account_id as string | undefined) ?? "",
    };
  });
}

export async function listBrowsers(run: Runner, options?: RunnerOptions): Promise<Browser[]> {
  const reply = await run(["browsers", "--json"], options);
  if (reply.exitCode !== 0) throw new ZenxError("BSK_FAILED", "bsk 无法列出连接；运行 zenx doctor 查看诊断。");
  return parseBrowsers(reply.stdout);
}

export function isEdge(browser: Browser): boolean {
  return /^(?:microsoft )?edge$/i.test(browser.browser_name);
}
export function protocolSupported(browser: Browser): boolean {
  return browser.extension_protocol_version === "1.0" || browser.extension_protocol_version === "1.1" || browser.extension_protocol_version === "1.3";
}

export async function doctor(run: Runner) {
  const checks: { name: string; status: "ok" | "fail" | "na"; detail: string }[] = [];
  try {
    const version = await run(["--version"]);
    checks.push({ name: "bsk_cli", status: version.exitCode === 0 ? "ok" : "fail", detail: version.stdout.trim() });
    const help = await run(["session", "start", "--help"]);
    const strict = help.exitCode === 0 && /--browser-id(?:\s|=)/.test(help.stdout);
    checks.push({ name: "strict_id_cli", status: strict ? "ok" : "fail", detail: strict ? "CLI 提供 --browser-id。" : "请使用包含 --browser-id 的新版 bsk。" });
    const report = await run(["doctor", "--json"]);
    const data = json(report.stdout);
    if (!Array.isArray(data) || data.length === 0 || data.some((item) => !object(item) || !text(item.name) || !["ok", "fail", "na"].includes(item.status as string) || typeof item.detail !== "string")) {
      throw new ZenxError("INVALID_BSK_OUTPUT", "bsk doctor 返回了不支持的诊断格式。");
    }
    for (const item of data) checks.push({ name: `bsk.${item.name}`, status: item.status, detail: item.detail });
    if (report.exitCode !== 0 && !data.some((item) => item.status === "fail")) {
      checks.push({ name: "bsk_exit", status: "fail", detail: "bsk doctor 以非零状态退出。" });
    }
  } catch (error) {
    checks.push({ name: "bsk_connection", status: "fail", detail: error instanceof Error ? error.message : "诊断失败。" });
  }
  checks.push({ name: "strict_id_daemon", status: "na", detail: "未创建 session，未验证正在运行的 daemon 是否支持 session.start_strict；CLI 支持不代表 daemon 已更新。" });
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

function validateBinding(alias: string, instanceId: string, expectedIdentity: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias)) throw new ZenxError("INVALID_ALIAS", "账号别名限 1–64 位字母、数字、下划线或连字符，以字母或数字开头。");
  if (!text(instanceId) || instanceId !== instanceId.trim() || instanceId.length > 128 || /\s/.test(instanceId)) throw new ZenxError("INVALID_INSTANCE", "必须指定非空、无空白的精确实例 ID。");
  if (!text(expectedIdentity) || expectedIdentity !== expectedIdentity.trim() || expectedIdentity.length > 200 || /[\r\n\x00-\x1f]/.test(expectedIdentity)) throw new ZenxError("INVALID_IDENTITY", "请提供目标站点预期用户名或用户 ID，不要填写密码或令牌。");
}

export async function readStore(home: string): Promise<Store> {
  let raw: string;
  try { raw = await readFile(join(home, "accounts.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, accounts: [] };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.accounts)) throw new Error();
    const aliases = new Set<string>();
    const ids = new Set<string>();
    for (const item of value.accounts) {
      if (!object(item) || typeof item.alias !== "string" || typeof item.instanceId !== "string" || typeof item.expectedIdentity !== "string" || !text(item.boundAt) || Number.isNaN(Date.parse(item.boundAt))) throw new Error();
      validateBinding(item.alias, item.instanceId, item.expectedIdentity);
      if ("launch" in item && !isLaunchConfig(item.launch)) throw new Error();
      if ("profileAccountId" in item && typeof item.profileAccountId !== "string") throw new Error();
      if ("profileAccountSource" in item && !["preferences", "bsk", "manual"].includes(item.profileAccountSource as string)) throw new Error();
      if (aliases.has(item.alias) || ids.has(item.instanceId)) throw new Error();
      aliases.add(item.alias);
      ids.add(item.instanceId);
    }
    return value as Store;
  } catch {
    throw new ZenxError("INVALID_STORE", "账号文件损坏、版本不支持或绑定重复；保留原文件，不会覆盖。请人工检查 accounts.json。");
  }
}

export async function withStoreLock<T>(home: string, action: () => Promise<T>): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "accounts.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ZenxError("STORE_BUSY", "账号配置或启动正在进行，或留有锁；确认没有其他 ZenX 进程后再人工清理锁目录。");
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function updateStore<T>(home: string, update: (store: Store) => Promise<T>): Promise<T> {
  return withStoreLock(home, async () => {
    const target = join(home, "accounts.json");
    const temp = join(dirname(target), `.accounts-${randomUUID()}.tmp`);
    try {
      const store = await readStore(home);
      const result = await update(store);
      await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temp, target);
      return result;
    } finally {
      await rm(temp, { force: true });
    }
  });
}

export async function bindAccount(home: string, run: Runner, account: Omit<Account, "boundAt" | "launch">, confirm: boolean): Promise<Account> {
  if (!confirm) throw new ZenxError("CONFIRM_REQUIRED", "请核对实例和账号后添加 --confirm；此操作只记录预期身份，不证明站点已登录该账号。");
  validateBinding(account.alias, account.instanceId, account.expectedIdentity);
  return updateStore(home, async (store) => {
    const browser = (await listBrowsers(run)).find((item) => item.instance_id === account.instanceId);
    if (!browser) throw new ZenxError("INSTANCE_OFFLINE", "绑定实例未在线；不按标签匹配，也不改选其他浏览器。");
    if (!isEdge(browser)) throw new ZenxError("NOT_EDGE", "首期仅允许绑定 Microsoft Edge 实例。");
    if (!protocolSupported(browser)) throw new ZenxError("UNSUPPORTED_PROTOCOL", "扩展协议未验证兼容；当前仅支持 1.0 / 1.1 / 1.3。");
    if (store.accounts.some((item) => item.alias === account.alias || item.instanceId === account.instanceId)) {
      throw new ZenxError("BINDING_EXISTS", "账号别名或实例 ID 已绑定；不会覆盖或自动重新绑定。");
    }
    const saved = { ...account, boundAt: new Date().toISOString() };
    store.accounts.push(saved);
    return saved;
  });
}

export async function checkAccounts(home: string, run: Runner) {
  const store = await readStore(home);
  if (store.accounts.length === 0) return { ok: false, code: "NO_ACCOUNTS", accounts: [] };
  const browsers = await listBrowsers(run);
  const accounts = store.accounts.map((account) => {
    const browser = browsers.find((item) => item.instance_id === account.instanceId);
    const connection = !browser ? "offline" : !isEdge(browser) ? "wrong_browser" : !protocolSupported(browser) ? "unsupported_protocol" : "online";
    return { ...account, connection, currentLabel: browser?.label ?? null, versionSkew: browser?.version_skew ?? null, identity: "not_verified" };
  });
  return { ok: accounts.every((item) => item.connection === "online"), accounts };
}
