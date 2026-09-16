#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindAccount, checkAccounts, createRunner, doctor, isEdge, listBrowsers, ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";
import { closeBrowser, configureLaunch, ensureOnline, inspectSite, openSite } from "./launch.ts";
import { checkinAccount } from "./checkin.ts";
import { isTabId } from "./site.ts";
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
  zenx accounts close <别名> --confirm [--timeout 45s]
  zenx accounts open-site <别名> [--tab-id <N>] [--timeout 45s]
  zenx accounts inspect-site <别名> [--tab-id <N>] [--timeout 45s]
  zenx accounts checkin <别名> [--timeout 3m]

全局选项：
  --json          输出 JSON
  --home <目录>   账号数据目录（优先于 ZENX_HOME；默认 CLI 所在项目的 .zenx，不随工作目录变化）
  --help          显示帮助

ZENX_BSK_PATH 指定 bsk 可执行文件（不是带参数的 shell 命令）。
profiles list 只识别已经连接的扩展实例，不枚举所有 Edge Profile。
bsk 查询可能自动启动本地 daemon；check 保持只读，不启动 Edge。
ensure-online / open-site 在线不启动，离线只启动一次已配置的 Windows Edge Profile。
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
--tab-id 仅供 open-site / inspect-site 使用，限 1–2147483647 的十进制整数。
需要支持严格用户标签命令的新版 bsk CLI、daemon 和扩展；不回退到 session 或标签名称。
--timeout 接受正整数加 ms/s/m，最大 5m，连接和站点操作共用总预算；超时不关闭 Edge。
切换/创建响应不确定时可能已生效，停止且不自动重试；不刷新、迁移或关闭已有标签。
启动可能将窗口带到前台；扩展连接被禁用时必须人工开启。
路径请从目标 Profile 的 edge://version 核对，不能把 edge-3 推断为 Profile 3。
绑定需要人工核对；连接在线不等于目标站点登录身份已验证。
不保存密码、Cookie 或令牌。
checkin 执行完整退出重登签到流程（隔离 session、不抢焦点、退出前核对登录身份）；
  遇 GitHub 授权/验证页或签到未确认时停止并报错，由人工处理后重试；其余命令保持只读。`;

type Dependencies = { run?: Runner; home?: string; output?: (line: string) => void; launchDependencies?: LaunchDependencies; checkinDependencies?: CheckinDependencies };

function parseTimeout(value = "45s"): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) throw new ZenxError("INVALID_TIMEOUT", "--timeout 需要正整数和 ms/s/m 单位，例如 45s，最大 5m。");
  const amount = Number(match[1]) * (match[2] === "m" ? 60_000 : match[2] === "s" ? 1000 : 1);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 300_000) throw new ZenxError("INVALID_TIMEOUT", "--timeout 必须在 1ms 到 5m 之间。");
  return amount;
}

function parseTabId(value?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !isTabId(Number(value))) throw new ZenxError("INVALID_TAB_ID", "--tab-id 必须是 1–2147483647 的十进制整数。");
  return Number(value);
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
        "tab-id": { type: "string" },
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
    const opening = group === "accounts" && action === "open-site";
    const inspecting = group === "accounts" && action === "inspect-site";
    const closing = group === "accounts" && action === "close";
    const checkingIn = group === "accounts" && action === "checkin";
    const allowed = new Set(["json", "home", "help"]);
    if (binding) for (const key of ["instance-id", "expected-identity", "confirm"]) allowed.add(key);
    if (configuring) for (const key of ["edge-path", "user-data-dir", "profile-directory", "confirm"]) allowed.add(key);
    if (ensuring || opening || inspecting || checkingIn || closing) allowed.add("timeout");
    if (opening || inspecting) allowed.add("tab-id");
    if (closing) allowed.add("confirm");
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) throw new ZenxError("INVALID_ARGUMENT", `此命令不接受 --${key}。`);
    }
    if (values.home !== undefined && !values.home.trim()) throw new ZenxError("INVALID_ARGUMENT", "--home 不能为空。");
    const home = resolveHome(values.home, dependencies.home);
    const run = dependencies.run ?? createRunner(process.env.ZENX_BSK_PATH);
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
    } else if (opening && alias && positionals.length === 3) {
      report = await openSite(home, run, alias, parseTabId(values["tab-id"]), parseTimeout(values.timeout), dependencies.launchDependencies);
    } else if (inspecting && alias && positionals.length === 3) {
      report = await inspectSite(home, run, alias, parseTabId(values["tab-id"]), parseTimeout(values.timeout), dependencies.launchDependencies);
    } else if (closing && alias && positionals.length === 3) {
      if (values.confirm !== true) throw new ZenxError("CONFIRM_REQUIRED", "关闭会退出该实例的全部 Edge 窗口（含无关窗口，未保存内容会丢失），需要 --confirm。");
      report = await closeBrowser(home, run, alias, parseTimeout(values.timeout), dependencies.launchDependencies);
    } else if (checkingIn && alias && positionals.length === 3) {
      report = await checkinAccount(home, run, alias, parseTimeout(values.timeout ?? "3m"), dependencies.checkinDependencies);
    } else {
      throw new ZenxError("INVALID_ARGUMENT", "命令或参数不正确；运行 zenx --help 查看用法。");
    }
    if (!asJson && !checkingIn && !closing) output("连接在线或打开站点不等于登录身份验证；未执行签到。");
    output(JSON.stringify(report, null, 2));
    return report.ok === false ? 1 : 0;
  } catch (error) {
    const code = error instanceof ZenxError ? error.code : "COMMAND_FAILED";
    const message = error instanceof Error ? error.message : "命令失败。";
    const details = error instanceof ZenxError ? error.details : undefined;
    output(asJson ? JSON.stringify({ ok: false, error: { code, message, ...details } }) : `${code}: ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
