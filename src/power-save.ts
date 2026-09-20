import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 签到期间阻止系统休眠。
 *
 * 为什么需要：批量签到要跑几十分钟，中间还有 15 分钟级的限流冷却；一旦系统进入
 * 休眠，CDP 连接断掉、页面停止渲染，签到会在半途失败，而失败又可能把账号留在
 * 登出态。
 *
 * 三条硬约束（决定了实现方式）：
 * 1. **只声明"我正在做事"，不改电源计划。** 不做 `powercfg /change standby-timeout`
 *    这类全局修改——那会影响机器上的一切，且异常退出后不会自动恢复。三个平台
 *    用的都是进程级的"执行状态/抑制请求"，进程结束即失效。
 * 2. **失败要能安全降级。** 命令不存在（没有 caffeinate / systemd-inhibit）、
 *    PowerShell 被策略禁止、Add-Type 编译失败，都不能让签到跑不起来：降级为
 *    `strategy: "none"`，记日志，继续签到。
 * 3. **超时必须自动释放。** 子进程自身带时长上限，Node 侧再挂一个定时器兜底，
 *    并且在主进程退出时同步 kill，避免留下孤儿进程一直阻止休眠。
 */

export type SleepStrategy =
  | "windows-execution-state"
  | "macos-caffeinate"
  | "linux-systemd-inhibit"
  | "none";

/** 默认防休眠时长：90 分钟，足够跑完一轮单账号签到并留出余量。 */
export const DEFAULT_INHIBIT_TIMEOUT_MS = 90 * 60_000;
/** 批量签到的默认防休眠时长：账号多，还要算上限流冷却。 */
export const DEFAULT_BATCH_INHIBIT_TIMEOUT_MS = 4 * 60 * 60_000;
/** 激活后确认子进程仍存活的等待（Windows 上要给 Add-Type 编译留时间）。 */
export const READY_PROBE_MS = 750;

/** spawn 的最小接口，测试据此注入替身，不必真的拉起系统命令。 */
export type SpawnLike = (command: string, args: string[]) => ChildLike;

export type ChildLike = {
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  on: (event: "error" | "exit", listener: (arg?: unknown) => void) => unknown;
};

export type InhibitCommand = {
  command: string;
  args: string[];
  strategy: Exclude<SleepStrategy, "none">;
};

/**
 * 按平台给出抑制命令。返回 null 表示这个平台没有可用手段（调用方据此降级）。
 */
export function inhibitCommand(
  platform: string,
  timeoutSec: number,
  pid: number,
  reason = "zenx check-in",
): InhibitCommand | null {
  const seconds = String(Math.max(1, Math.ceil(timeoutSec)));
  if (platform === "win32") {
    // SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)：声明"本进程需要
    // 系统保持运行"。它是线程/进程级的，不写电源计划，进程退出即自动失效。
    // 循环里每 5 秒确认父进程还在——父进程被强杀时子进程也要跟着退，否则会留下
    // 一个一直阻止休眠的孤儿。
    const script = [
      "$ErrorActionPreference='Stop'",
      "try {",
      "  Add-Type -Namespace ZenxPower -Name Api -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);' -ErrorAction Stop",
      "  $null = [ZenxPower.Api]::SetThreadExecutionState([uint32]2147483649)",
      `  $deadline = (Get-Date).AddSeconds(${seconds})`,
      "  while ((Get-Date) -lt $deadline) {",
      "    Start-Sleep -Seconds 5",
      `    if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }`,
      "  }",
      "} catch { exit 1 }",
    ].join("\n");
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script], strategy: "windows-execution-state" };
  }
  if (platform === "darwin") {
    // -d 阻止显示器休眠；-w 跟随给定 pid（父进程没了 caffeinate 自己退出）；
    // -t 是时长上限，双保险。
    return { command: "caffeinate", args: ["-d", "-w", String(pid), "-t", seconds], strategy: "macos-caffeinate" };
  }
  if (platform === "linux") {
    // systemd-inhibit 只在其包裹的命令运行期间生效，所以拿 sleep 当占位命令；
    // 没有 systemd 时会直接失败（ENOENT），由调用方降级。
    return {
      command: "systemd-inhibit",
      args: ["--what=sleep:idle", "--who=zenx", "--why", reason, "sleep", seconds],
      strategy: "linux-systemd-inhibit",
    };
  }
  return null;
}

export type SleepInhibitHandle = {
  /** 实际生效的策略；"none" 表示已降级（见 note）。 */
  strategy: SleepStrategy;
  active: boolean;
  startedAt: string;
  /** 预计失效时间；降级或手动关闭后仍保留原计划值，便于对账。 */
  expiresAt: string | null;
  /** 降级原因；仅 strategy 为 "none" 时有值。 */
  note?: string;
  stop: () => Promise<void>;
};

export type SleepInhibitOptions = {
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  spawn?: SpawnLike;
  platform?: string;
  reason?: string;
};

function minutesOf(ms: number): string {
  return (ms / 60_000).toFixed(1).replace(/\.0$/, "");
}

/**
 * 开启防休眠。任何异常都降级为 `strategy: "none"`，绝不抛出、绝不阻塞签到。
 */
export async function startSleepInhibit(options: SleepInhibitOptions = {}): Promise<SleepInhibitHandle> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_INHIBIT_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;

  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const expiresAt = new Date(startedMs + timeoutMs).toISOString();

  // 降级一律记为 strategy "none"：active=false 与 strategy="none" 等价，看一个字段就知道
  // 有没有生效；试过哪种手段写进 note，便于排查"为什么这台机器上没生效"。
  const inactive = (note: string): SleepInhibitHandle => {
    log(`防休眠未启用（策略=none）：${note}；签到继续。`);
    return { strategy: "none", active: false, startedAt, expiresAt: null, note, stop: async () => undefined };
  };

  const spec = inhibitCommand(platform, timeoutMs / 1000, process.pid, options.reason);
  if (!spec) return inactive(`平台 ${platform} 没有可用的防休眠手段`);

  const spawnFn =
    options.spawn ??
    ((command: string, args: string[]) => spawn(command, args, { stdio: "ignore", windowsHide: true }) as unknown as ChildLike);
  let child: ChildLike;
  try {
    child = spawnFn(spec.command, spec.args);
  } catch (error) {
    return inactive(`启动 ${spec.strategy} 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let stopped = false;
  let failure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.on("error", (arg?: unknown) => {
    failure = arg instanceof Error ? arg.message : String(arg ?? "子进程错误");
  });
  child.on("exit", (arg?: unknown) => {
    // 只有"还没主动收工就退出"才算激活失败；到期自然退出是正常的。
    if (!stopped && typeof arg === "number" && arg !== 0) failure = `子进程提前退出（退出码 ${arg}）`;
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (typeof process.off === "function") process.off("exit", onProcessExit);
    try { child.kill(); } catch { /* 已经退出了 */ }
    log(`防休眠已关闭：策略=${spec.strategy}，开始=${startedAt}，结束=${new Date(now()).toISOString()}，持续约 ${minutesOf(Math.max(0, now() - startedMs))} 分钟。`);
  };

  const onProcessExit = (): void => {
    try { child.kill(); } catch { /* 忽略：进程正在退出 */ }
  };
  process.once("exit", onProcessExit);

  timer = setTimeout(() => {
    if (stopped) return;
    failure = null;
    void stop().then(() => log(`防休眠已到超时上限（${minutesOf(timeoutMs)} 分钟），自动释放。`));
  }, timeoutMs);
  // 不阻止 Node 退出：签到跑完就该走，不该被这个定时器吊住。
  if (typeof timer.unref === "function") timer.unref();

  // 给激活留一点时间（Windows 上 Add-Type 要编译），期间子进程若已失败就能发现。
  await sleep(READY_PROBE_MS);
  if (failure) {
    await stop();
    return inactive(`${spec.strategy} 激活失败：${failure}`);
  }
  if (child.exitCode !== null && child.exitCode !== 0) {
    await stop();
    return inactive(`${spec.strategy} 激活失败：子进程退出码 ${child.exitCode}`);
  }

  log(`防休眠已开启：策略=${spec.strategy}，开始=${startedAt}，计划结束=${expiresAt}（上限 ${minutesOf(timeoutMs)} 分钟）。`);
  return { strategy: spec.strategy, active: true, startedAt, expiresAt, stop };
}

/**
 * 在 fn 执行期间保持防休眠，无论 fn 成功还是抛错都会释放。
 * options 传 null 表示整段不启用（--inhibit-sleep no）。
 */
export async function withSleepInhibit<T>(options: SleepInhibitOptions | null, fn: () => Promise<T>): Promise<T> {
  if (!options) return fn();
  const guard = await startSleepInhibit(options);
  try {
    return await fn();
  } finally {
    await guard.stop();
  }
}
