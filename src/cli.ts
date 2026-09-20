#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindAccount, checkAccounts, createRunner, doctor, isEdge, listBrowsers, ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";
import { closeBrowser, configureLaunch, ensureOnline, inspectSite, openSite, relinkAccount } from "./launch.ts";
import { checkinAccount } from "./checkin.ts";
import { loginAccount } from "./login.ts";
import { checkinAll, pendingCheckins } from "./checkin-batch.ts";
import { recheckAccount } from "./recheck.ts";
import { snapshotAccount, snapshotAll } from "./snapshot.ts";
import { startReportServer } from "./report.ts";
import { isTabId } from "./site.ts";
import { DEFAULT_BATCH_INHIBIT_TIMEOUT_MS, withSleepInhibit } from "./power-save.ts";
import type { SleepInhibitOptions, SpawnLike } from "./power-save.ts";
import type { LaunchDependencies } from "./launch.ts";
import type { CheckinDependencies } from "./checkin.ts";

export const DEFAULT_HOME = fileURLToPath(new URL("../.zenx/", import.meta.url));

export function resolveHome(explicit?: string, injected?: string, environment = process.env.ZENX_HOME): string {
  return resolve(explicit ?? injected ?? environment ?? DEFAULT_HOME);
}

const help = `ZenX Browser — Windows Edge 多账号连接台

用法：
  zenx doctor
  zenx profiles list
  zenx accounts bind <别名> --instance-id <ID> --expected-identity <站点用户名或ID> --confirm
  zenx accounts check
  zenx accounts configure-launch <别名> --edge-path <msedge.exe绝对路径> --user-data-dir <用户数据根目录> --profile-directory <Profile子目录> --confirm
  zenx accounts ensure-online <别名> [--timeout 45s]
  zenx accounts relink-account <别名> --confirm [--timeout 2m]
  zenx accounts close <别名> --confirm [--timeout 45s]
  zenx accounts open-site <别名> [--tab-id <N>] [--timeout 45s]
  zenx accounts inspect-site <别名> [--tab-id <N>] [--timeout 45s]
  zenx accounts login <别名> [--timeout 3m]
  zenx accounts checkin <别名> [--timeout 3m] [--force] [--close-after] [--inhibit-sleep yes|no] [--inhibit-timeout 4m]
  zenx accounts checkin-all [--timeout 3m] [--wait 15m] [--retries 1] [--window 8] [--close-after] [--retry-codes CODES] [--inhibit-sleep yes|no] [--inhibit-timeout 4h]
  zenx accounts recheck <别名> [--timeout 45s] [--record yes|no]
  zenx accounts snapshot <别名> [--timeout 45s]
  zenx accounts snapshot --all [--timeout 45s]
  zenx report [--port 8787] [--open]

全局选项：
  --json          输出 JSON
  --home <目录>   账号数据目录（优先于 ZENX_HOME；默认 CLI 所在项目的 .zenx，不随工作目录变化）
  --port <端口>   report 监听端口（默认 8787）
  --open          report 启动后自动打开浏览器
  --help          显示帮助

ZENX_BSK_PATH 指定 bsk 可执行文件（不是带参数的 shell 命令）。
profiles list 只识别已经连接的扩展实例，不枚举所有 Edge Profile。
bsk 查询可能自动启动本地 daemon；check 保持只读，不启动 Edge。
ensure-online / open-site 在线不启动，离线只启动一次已配置的 Windows Edge Profile。
relink-account 在 Edge 重启导致实例 ID 变化后，用**账号锚点**重新定位并改绑，
  不受 Profile 显示名改名影响（旧的显示名匹配方式已移除）：
  先读该 Profile 的 Preferences.account_info.account_id 作为锚点；若 bsk 直接上报
  profile_account_id（fork 构建 + 扩展开关）就直接比对，零探测；否则回退到开临时
  隔离窗口 + 标题标记定位 Profile 子目录，再读其 account_id 比对。
  锚点缺失报 ACCOUNT_ANCHOR_MISSING；命中多个实例报 PROFILE_AMBIGUOUS，均不改绑。
  锚点只是不透明账号 ID，不是邮箱或凭证；configure-launch 时自动记录。
close 与 ensure-online 成对：关闭账号绑定的那个 Edge 实例（停止其全部会话后关闭所有窗口，
  浏览器进程随之退出）；只用已绑定的精确实例 ID，离线、非 Edge 或协议不兼容都直接报错，
  不按标签匹配也不改选；必须 --confirm；失败不重试（可能已关闭），用 zenx accounts check 核对。
  会关闭该实例的所有窗口，包括与本项目无关的窗口，未保存内容会丢失。
不显式打开空白窗口；Edge 自身启动设置仍可能恢复窗口或新标签，无法保证消除。
open-site 本期仅支持 https://agentrouter.org/；先查找并切换用户已有标签，无匹配才新建。
多个候选仅在唯一 active 匹配时自动选择，否则用 --tab-id 明确选择；错误候选不新建。
inspect-site 只读采集既有 AgentRouter 标签当前视口可见正文，核对登录身份与签到信号；
  不启动 Edge、不切换/新建/刷新标签、不执行签到；离线直接报告，不等待。
  页面在扩展更新前已加载时没有只读接收器，需人工刷新该标签后重试。
snapshot 采集一次"当前余额 + 站点累计消耗"写入账本（只读：不退出、不重登录、不消耗登录配额）；
  与 checkin 只记录签到那一刻不同，它提供连续观测点，供周/月对比到账与消耗；
  --all 依次采集全部已绑定账号，单个失败不中断；失败也留一条（ok=false + 错误码）。
recheck 只读复查某账号"今日签到额度是否已到账"：开隔离窗口读一次控制台，结合账本给出结论；
  不退出、不重新登录、不消耗站点登录配额，可在签到失败或未确认后反复使用。
  确认到账但账本今天没有记录时，默认补记一条到账记录（--record no 可关闭）：
  额度未必由 checkin 发放（zenx accounts login 恢复登录态也会发放），钱领到了就不该
  因为记录路径不同而从账本与报表里消失。
  退出码 0=已确认到账，1=未到账或异常；离线/非 Edge/协议不兼容只报告，不启动 Edge（先 ensure-online）；
  遇 GitHub 授权/验证页或登录身份不符时停止判断，不给出额度结论。
--tab-id 仅供 open-site / inspect-site 使用，限 1–2147483647 的十进制整数。
需要支持严格用户标签命令的新版 bsk CLI、daemon 和扩展；不回退到 session 或标签名称。
--timeout 接受正整数加 ms/s/m，最大 5m，连接和站点操作共用总预算；超时不关闭 Edge。
切换/创建响应不确定时可能已生效，停止且不自动重试；不刷新、迁移或关闭已有标签。
启动可能将窗口带到前台；扩展连接被禁用时必须人工开启。
路径请从目标 Profile 的 edge://version 核对，不能把 edge-3 推断为 Profile 3。
绑定需要人工核对；连接在线不等于目标站点登录身份已验证。
不保存密码、Cookie 或令牌。
checkin 执行完整退出重登签到流程（隔离 session、退出前核对登录身份）；
  支持无人值守：窗口被遮挡或锁屏时仍可执行，交互前通过 evaluate 收敛页面动画；
  硬性前提是隔离窗口至少绘制过一帧——最小化的窗口会丢弃全部输入，此时报 WINDOW_NOT_INTERACTIVE
  （计划任务脚本需先恢复最小化的 Edge 窗口）；遇 GitHub 授权/验证页或签到未确认时
  停止并报错，由人工处理后重试；其余命令保持只读。
checkin 在当天账本已有"确认到账"记录、或站点显示"今日已签到"时直接跳过（不退出重登），
  避免白扣站点登录配额；确需重跑加 --force。
checkin 默认只回收本次的隔离窗口，Edge 进程留着；加 --close-after 则在**签到成功后**
  连带关掉整个浏览器实例（停其全部会话 + 关其所有窗口，含与本项目无关的窗口，未保存
  内容会丢）。失败时不关——账号可能停在登出态，留着窗口便于人工处理。
login 只补"登录"这一步（不退出、不签到）：用于 checkin 在重登阶段失败后账号停在登出态、
  因而连 checkin 都无法再启动的自救；已登录则原样返回，不动账号状态。
checkin-all 依次处理全部账号，并自动处理站点登录限流：命中限流/登录超时的账号记录等待起点，
  冷却 --wait（默认 15 分钟）后自动重试 --retries 次（默认 1）。--window（默认 8）限制同时在线
  的账号数：一组签完立刻关掉它们的 Edge 实例再拉下一组，把内存峰值压在窗口大小内（0=不分组）。
  --close-after 即使不分组也逐个账号关闭；状态落在 .zenx/checkin-state.json，单个账号失败不中断后续。
  两个命令在开始前都会开启**防休眠**（进程级，不改电源计划）：跑几十分钟、中间还可能
  等限流冷却，休眠一次就会整轮中断。--inhibit-sleep no 关闭；--inhibit-timeout 设上限
  （默认单账号 签到预算+1m、批量 4h，最长 24h），到点自动释放。激活失败只是降级并记日志，
  不会中断签到。`;

type Dependencies = {
  run?: Runner;
  home?: string;
  output?: (line: string) => void;
  launchDependencies?: LaunchDependencies;
  checkinDependencies?: CheckinDependencies;
  /** report 使用的数据库文件（测试注入用）。 */
  reportDbFile?: string;
  /** recheck 使用的签到账本（测试注入用）。 */
  recheckDbFile?: string;
  /** snapshot 使用的账本（测试注入用）。 */
  snapshotDbFile?: string;
  /** 当前时间替身（测试注入用）；不注入则用真实时钟。 */
  now?: () => Date;
  /** 防休眠的系统调用替身（测试注入用）；不注入则用真实 spawn。 */
  inhibitSpawn?: SpawnLike;
};

function parseTimeout(value = "45s"): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) throw new ZenxError("INVALID_TIMEOUT", "--timeout 需要正整数和 ms/s/m 单位，例如 45s，最大 5m。");
  const amount = Number(match[1]) * (match[2] === "m" ? 60_000 : match[2] === "s" ? 1000 : 1);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 300_000) throw new ZenxError("INVALID_TIMEOUT", "--timeout 必须在 1ms 到 5m 之间。");
  return amount;
}

/** 冷却时长：接受正整数加 ms/s/m，默认与上限均为 60 分钟。 */
function parseDuration(value: string, invalidCode: string, label: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) throw new ZenxError(invalidCode, `${label} 需要正整数和 ms/s/m 单位，例如 15m。`);
  const amount = Number(match[1]) * (match[2] === "m" ? 60_000 : match[2] === "s" ? 1000 : 1);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 3_600_000) {
    throw new ZenxError(invalidCode, `${label} 必须在 1ms 到 60m 之间。`);
  }
  return amount;
}

/** 防休眠开关：`--inhibit-sleep yes`（默认）/ `--inhibit-sleep no`。 */
function parseInhibitFlag(value?: string): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (["yes", "y", "true", "on", "1"].includes(normalized)) return true;
  if (["no", "n", "false", "off", "0"].includes(normalized)) return false;
  throw new ZenxError("INVALID_ARGUMENT", "--inhibit-sleep 只接受 yes / no。");
}

/**
 * 防休眠时长。单独一套解析是因为它比 --wait 宽得多：批量签到连同限流冷却可能跑
 * 几个小时，而 --wait 上限是 60m。上限 24h 是为了不让"忘记释放"变成永久阻止休眠。
 */
function parseInhibitTimeout(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new ZenxError("INVALID_INHIBIT_TIMEOUT", "--inhibit-timeout 需要正整数和 ms/s/m/h 单位，例如 90m 或 3h。");
  const unit = match[2];
  const amount = Number(match[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1);
  if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 24 * 3_600_000) {
    throw new ZenxError("INVALID_INHIBIT_TIMEOUT", "--inhibit-timeout 必须在 1s 到 24h 之间。");
  }
  return amount;
}

function parseRetries(value?: string): number {
  if (value === undefined) return 1;
  if (!/^\d{1,2}$/.test(value) || Number(value) > 5) throw new ZenxError("INVALID_RETRIES", "--retries 必须是 0 到 5 的整数。");
  return Number(value);
}

/** 同时在线账号上限：缺省=默认 8，0=不分组，1–64 为窗口大小。 */
function parseWindow(value?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,2}$/.test(value)) throw new ZenxError("INVALID_WINDOW", "--window 必须是 0 到 64 的整数（0 表示不分组）。");
  const size = Number(value);
  if (size > 64) throw new ZenxError("INVALID_WINDOW", "--window 上限 64。");
  return size;
}

/** recheck 是否补记账本：`--record yes`（默认）/ `--record no`。 */
function parseRecordFlag(value?: string): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (["yes", "y", "true", "on", "1"].includes(normalized)) return true;
  if (["no", "n", "false", "off", "0", "skip"].includes(normalized)) return false;
  throw new ZenxError("INVALID_ARGUMENT", "--record 只接受 yes / no。");
}

function parseRetryCodes(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  const codes = value.split(",").map((item) => item.trim().toUpperCase()).filter((item) => item.length > 0);
  if (codes.length === 0) throw new ZenxError("INVALID_RETRY_CODES", "--retry-codes 至少需要一个错误码，例如 LOGIN_RATE_LIMITED,LOGIN_TIMEOUT。");
  return codes;
}

function parseTabId(value?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !isTabId(Number(value))) throw new ZenxError("INVALID_TAB_ID", "--tab-id 必须是 1–2147483647 的十进制整数。");
  return Number(value);
}

function parsePort(value?: string): number {
  if (value === undefined) return 8787;
  if (!/^\d+$/.test(value)) throw new ZenxError("INVALID_PORT", "--port 必须是 1–65535 的十进制整数。");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ZenxError("INVALID_PORT", "--port 必须是 1–65535 的十进制整数。");
  return port;
}

/** 启动报表服务器并保持运行，直到用户中断。 */
async function runReport(
  values: Record<string, string | boolean | undefined>,
  output: (line: string) => void,
  dependencies: Dependencies,
): Promise<number> {
  const port = parsePort(values.port as string | undefined);
  let server: Awaited<ReturnType<typeof startReportServer>> | undefined;
  try {
    server = await startReportServer({
      port,
      dbFile: dependencies.reportDbFile,
      home: resolveHome(values.home, dependencies.home),
      onStart: (url) => output(`报表已启动：${url}（Ctrl+C 停止）`),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new ZenxError("PORT_IN_USE", `端口 ${port} 已被占用；用 --port 指定其他端口。`);
    }
    throw error;
  }
  if (values.open === true) {
    const url = `http://127.0.0.1:${port}/`;
    // Windows 用 start，其他平台用 open/xdg-open；失败仅提示，不影响服务运行。
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(command, args, { shell: false, detached: true, stdio: "ignore" }).on("error", () => {
      output(`无法自动打开浏览器，请手动访问 ${url}`);
    }).unref();
  }
  // 保持进程存活直到收到中断信号。
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server?.on("close", stop);
  });
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  output("报表已停止。");
  return 0;
}

export async function main(args: string[], dependencies: Dependencies = {}): Promise<number> {
  const output = dependencies.output ?? console.log;
  const asJson = args.includes("--json");
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean" },
        home: { type: "string" },
        "instance-id": { type: "string" },
        "expected-identity": { type: "string" },
        confirm: { type: "boolean" },
        "edge-path": { type: "string" },
        "user-data-dir": { type: "string" },
        "profile-directory": { type: "string" },
        timeout: { type: "string" },
        force: { type: "boolean" },
        wait: { type: "string" },
        retries: { type: "string" },
        "retry-codes": { type: "string" },
        "close-after": { type: "boolean" },
        record: { type: "string" },
        window: { type: "string" },
        all: { type: "boolean" },
        "tab-id": { type: "string" },
        port: { type: "string" },
        open: { type: "boolean" },
        "inhibit-sleep": { type: "string" },
        "inhibit-timeout": { type: "string" },
      },
    });
    const { values, positionals, tokens } = parsed;
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) throw new ZenxError("INVALID_ARGUMENT", `选项 --${token.name} 不能重复指定。`);
      seen.add(token.name);
    }
    if (values.help || args.length === 0) { output(help); return 0; }
    const [group, action, alias] = positionals;
    const binding = group === "accounts" && action === "bind";
    const configuring = group === "accounts" && action === "configure-launch";
    const ensuring = group === "accounts" && action === "ensure-online";
    const relinking = group === "accounts" && action === "relink-account";
    const opening = group === "accounts" && action === "open-site";
    const inspecting = group === "accounts" && action === "inspect-site";
    const closing = group === "accounts" && action === "close";
    const loggingIn = group === "accounts" && action === "login";
    const checkingInAll = group === "accounts" && action === "checkin-all";
    const pendingList = group === "accounts" && action === "pending";
    const checkingIn = group === "accounts" && action === "checkin";
    const rechecking = group === "accounts" && action === "recheck";
    const snapshotting = group === "accounts" && action === "snapshot";
    const reporting = group === "report" && positionals.length === 1;
    const allowed = new Set(["json", "home", "help"]);
    if (binding) for (const key of ["instance-id", "expected-identity", "confirm"]) allowed.add(key);
    if (configuring) for (const key of ["edge-path", "user-data-dir", "profile-directory", "confirm"]) allowed.add(key);
    if (ensuring || opening || inspecting || relinking || closing || rechecking || snapshotting) allowed.add("timeout");
    if (rechecking) allowed.add("record");
    if (snapshotting) allowed.add("all");
    if (loggingIn) allowed.add("timeout");
    if (checkingInAll) for (const key of ["timeout", "wait", "retries", "retry-codes", "close-after", "window", "inhibit-sleep", "inhibit-timeout"]) allowed.add(key);
    if (checkingIn) for (const key of ["timeout", "force", "inhibit-sleep", "inhibit-timeout", "close-after"]) allowed.add(key);
    if (relinking || closing) allowed.add("confirm");
    if (opening || inspecting) allowed.add("tab-id");
    if (reporting) for (const key of ["port", "open"]) allowed.add(key);
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) throw new ZenxError("INVALID_ARGUMENT", `此命令不接受 --${key}。`);
    }
    if (values.home !== undefined && !values.home.trim()) throw new ZenxError("INVALID_ARGUMENT", "--home 不能为空。");
    if (snapshotting && values.all === true && alias !== undefined) throw new ZenxError("INVALID_ARGUMENT", "--all 会采集全部账号，不能再指定别名。");
    const home = resolveHome(values.home, dependencies.home);
    const run = dependencies.run ?? createRunner(process.env.ZENX_BSK_PATH);
    // 防休眠配置：返回 null 表示整段不启用。日志走与进度相同的出口，JSON 模式下不打印。
    const inhibitOptions = (
      defaultTimeoutMs: number,
      log: (line: string) => void,
    ): SleepInhibitOptions | null => {
      if (!parseInhibitFlag(values["inhibit-sleep"] as string | undefined)) return null;
      return {
        timeoutMs: parseInhibitTimeout(values["inhibit-timeout"] as string | undefined) ?? defaultTimeoutMs,
        log,
        ...(dependencies.inhibitSpawn ? { spawn: dependencies.inhibitSpawn } : {}),
      };
    };
    let report: Record<string, unknown>;
    if (group === "doctor" && positionals.length === 1) {
      report = await doctor(run);
    } else if (group === "profiles" && action === "list" && positionals.length === 2) {
      const browsers = await listBrowsers(run);
      report = { ok: true, profiles: browsers.map((browser) => ({ ...browser, supported: isEdge(browser) })), scope: "connected_extensions_only" };
    } else if (binding && alias && positionals.length === 3) {
      const account = await bindAccount(home, run, {
        alias,
        instanceId: values["instance-id"] ?? "",
        expectedIdentity: values["expected-identity"] ?? "",
      }, values.confirm === true);
      report = { ok: true, account, identity: "not_verified", dataDirectory: home };
    } else if (group === "accounts" && action === "check" && positionals.length === 2) {
      report = await checkAccounts(home, run);
    } else if (configuring && alias && positionals.length === 3) {
      const account = await configureLaunch(home, alias, {
        edgePath: values["edge-path"] ?? "",
        userDataDir: values["user-data-dir"] ?? "",
        profileDirectory: values["profile-directory"] ?? "",
      }, values.confirm === true);
      report = { ok: true, account, identity: "not_verified", dataDirectory: home };
    } else if (ensuring && alias && positionals.length === 3) {
      report = await ensureOnline(home, run, alias, parseTimeout(values.timeout), dependencies.launchDependencies);
    } else if (relinking && alias && positionals.length === 3) {
      if (values.confirm !== true) throw new ZenxError("CONFIRM_REQUIRED", "改绑实例 ID 会修改账号配置，需要 --confirm。");
      report = await relinkAccount(home, run, alias, parseTimeout(values.timeout ?? "2m"), dependencies.launchDependencies);
    } else if (opening && alias && positionals.length === 3) {
      report = await openSite(home, run, alias, parseTabId(values["tab-id"]), parseTimeout(values.timeout), dependencies.launchDependencies);
    } else if (inspecting && alias && positionals.length === 3) {
      report = await inspectSite(home, run, alias, parseTabId(values["tab-id"]), parseTimeout(values.timeout), dependencies.launchDependencies);
    } else if (closing && alias && positionals.length === 3) {
      if (values.confirm !== true) throw new ZenxError("CONFIRM_REQUIRED", "关闭会退出该实例的全部 Edge 窗口（含无关窗口，未保存内容会丢失），需要 --confirm。");
      report = await closeBrowser(home, run, alias, parseTimeout(values.timeout), dependencies.launchDependencies);
    } else if (loggingIn && alias && positionals.length === 3) {
      report = await loginAccount(home, run, alias, parseTimeout(values.timeout ?? "3m"), {
        dbFile: dependencies.recheckDbFile,
      });
    } else if (pendingList && positionals.length === 2) {
      // 只读账本，不调 bsk、不拉起 Edge：签到前先看今天还差谁。
      report = await pendingCheckins(home, { dbFile: dependencies.snapshotDbFile, now: dependencies.now });
    } else if (checkingInAll && positionals.length === 2) {
      const progress = (line: string) => { if (!asJson) output(line); };
      // 防休眠覆盖整轮批量：账号多、还可能撞上限流冷却，中途休眠会让后续账号全部中断。
      report = await withSleepInhibit(
        inhibitOptions(DEFAULT_BATCH_INHIBIT_TIMEOUT_MS, progress),
        () => checkinAll(home, run, {
          checkinTimeoutMs: parseTimeout(values.timeout ?? "3m"),
          waitMs: values.wait === undefined ? undefined : parseDuration(values.wait, "INVALID_WAIT", "--wait"),
          maxRetries: parseRetries(values.retries),
          retryCodes: parseRetryCodes(values["retry-codes"]),
          closeAfter: values["close-after"] === true,
          windowSize: parseWindow(values.window),
          dbFile: dependencies.snapshotDbFile,
          onProgress: progress,
        }),
      );
    } else if (checkingIn && alias && positionals.length === 3) {
      const timeoutMs = parseTimeout(values.timeout ?? "3m");
      report = await withSleepInhibit(
        // 单账号的防休眠只需覆盖这一次签到，留 1 分钟余量给收尾。
        inhibitOptions(timeoutMs + 60_000, (line) => { if (!asJson) output(line); }),
        () => checkinAccount(home, run, alias, timeoutMs, {
          ...dependencies.checkinDependencies,
          force: values.force === true,
          closeAfter: values["close-after"] === true,
        }),
      );
    } else if (rechecking && alias && positionals.length === 3) {
      report = await recheckAccount(home, run, alias, parseTimeout(values.timeout), {
        dbFile: dependencies.recheckDbFile,
        record: parseRecordFlag(values.record),
      });
    } else if (snapshotting && values.all === true && positionals.length === 2) {
      report = await snapshotAll(home, run, parseTimeout(values.timeout), {
        dbFile: dependencies.snapshotDbFile,
      });
    } else if (snapshotting && alias && positionals.length === 3) {
      report = await snapshotAccount(home, run, alias, parseTimeout(values.timeout), {
        dbFile: dependencies.snapshotDbFile,
      });
    } else if (reporting) {
      return await runReport(values, output, dependencies);
    } else {
      throw new ZenxError("INVALID_ARGUMENT", "命令或参数不正确；运行 zenx --help 查看用法。");
    }
    if (!asJson && !checkingIn && !checkingInAll && !closing && !rechecking && !snapshotting && !loggingIn) output("连接在线或打开站点不等于登录身份验证；未执行签到。");
    output(JSON.stringify(report, null, 2));
    return report.ok === false ? 1 : 0;
  } catch (error) {
    const code = error instanceof ZenxError ? error.code : "COMMAND_FAILED";
    const message = error instanceof Error ? error.message : "命令失败。";
    const details = error instanceof ZenxError ? error.details : undefined;
    const hint = error instanceof ZenxError ? error.hint : undefined;
    if (asJson) {
      output(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}), ...details } }));
    } else {
      output(hint ? `${code}: ${message}\nhint: ${hint}` : `${code}: ${message}`);
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
