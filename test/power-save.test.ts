import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INHIBIT_TIMEOUT_MS,
  inhibitCommand,
  startSleepInhibit,
  withSleepInhibit,
} from "../src/power-save.ts";
import type { ChildLike } from "../src/power-save.ts";

type FakeChild = ChildLike & {
  killed: number;
  emit: (event: "error" | "exit", arg?: unknown) => void;
};

function fakeChild(exitCode: number | null = null): FakeChild {
  const listeners = new Map<string, (arg?: unknown) => void>();
  const child = {
    exitCode,
    killed: 0,
    kill: () => {
      child.killed += 1;
      return true;
    },
    on: (event: "error" | "exit", listener: (arg?: unknown) => void) => {
      listeners.set(event, listener);
      return child;
    },
    emit: (event: "error" | "exit", arg?: unknown) => listeners.get(event)?.(arg),
  };
  return child as FakeChild;
}

function harness(child: FakeChild | null, options: { spawnError?: string } = {}) {
  const lines: string[] = [];
  const spawn = () => {
    if (options.spawnError) throw new Error(options.spawnError);
    assert.ok(child, "本用例不该走到 spawn");
    return child;
  };
  return {
    lines,
    options: {
      platform: "linux",
      timeoutMs: 60_000,
      now: () => 1_700_000_000_000,
      log: (line: string) => lines.push(line),
      spawn,
      // 探测等待里触发事件：模拟"启动后立刻失败"。
      sleep: async () => undefined,
    },
  };
}

test("inhibitCommand 按平台给出进程级抑制命令", () => {
  assert.equal(inhibitCommand("darwin", 60, 4242)?.command, "caffeinate");
  assert.deepEqual(inhibitCommand("darwin", 60, 4242)?.args.slice(0, 3), ["-d", "-w", "4242"]);
  assert.equal(inhibitCommand("linux", 60, 4242)?.command, "systemd-inhibit");
  const windows = inhibitCommand("win32", 60, 4242);
  assert.equal(windows?.command, "powershell");
  assert.equal(windows?.strategy, "windows-execution-state");
});

test("Windows 用 SetThreadExecutionState，且子进程会跟着父进程退出", () => {
  const spec = inhibitCommand("win32", 90, 4242);
  assert.ok(spec);
  const script = spec.args[spec.args.length - 1];
  assert.match(script, /SetThreadExecutionState/);
  assert.match(script, /2147483649/, "ES_CONTINUOUS | ES_SYSTEM_REQUIRED");
  assert.match(script, /Get-Process -Id 4242/, "父进程没了要自己退出，否则会留下阻止休眠的孤儿");
});

test("不支持的平台返回 null（由调用方降级）", () => {
  assert.equal(inhibitCommand("freebsd", 60, 1), null);
});

test("激活成功：记录策略与起止时间", async () => {
  const child = fakeChild();
  const { lines, options } = harness(child);
  const handle = await startSleepInhibit(options);
  assert.equal(handle.strategy, "linux-systemd-inhibit");
  assert.equal(handle.active, true);
  assert.equal(handle.startedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(handle.expiresAt, new Date(1_700_000_060_000).toISOString());
  assert.ok(lines.some((line) => line.includes("防休眠已开启") && line.includes(handle.strategy)));
  await handle.stop();
  assert.equal(child.killed, 1);
  assert.ok(lines.some((line) => line.includes("防休眠已关闭")));
});

test("stop 幂等：重复调用只 kill 一次", async () => {
  const child = fakeChild();
  const { options } = harness(child);
  const handle = await startSleepInhibit(options);
  await handle.stop();
  await handle.stop();
  assert.equal(child.killed, 1);
});

test("spawn 抛错 → 降级为 none，不抛出、不阻塞签到", async () => {
  const { lines, options } = harness(null, { spawnError: "spawn ENOENT" });
  const handle = await startSleepInhibit(options);
  assert.equal(handle.strategy, "none");
  assert.equal(handle.active, false);
  assert.match(handle.note ?? "", /ENOENT/);
  assert.ok(lines.some((line) => line.includes("防休眠未启用") && line.includes("签到继续")));
  await handle.stop();  // 降级后 stop 必须是安全的空操作
});

test("子进程启动后立刻报错 → 降级，且不留子进程", async () => {
  const child = fakeChild();
  const { lines, options } = harness(child);
  // 探测等待期间子进程出错（例如命令不存在）。
  const handle = await startSleepInhibit({
    ...options,
    sleep: async () => { child.emit("error", new Error("spawn caffeinate ENOENT")); },
  });
  assert.equal(handle.active, false);
  assert.equal(handle.strategy, "none");
  assert.match(handle.note ?? "", /linux-systemd-inhibit/, "降级也要说清试过哪种手段");
  assert.match(handle.note ?? "", /ENOENT/);
  assert.equal(child.killed, 1, "激活失败也要收掉子进程");
  assert.ok(lines.some((line) => line.includes("防休眠未启用")));
});

test("子进程非零退出 → 降级", async () => {
  const child = fakeChild();
  const { options } = harness(child);
  const handle = await startSleepInhibit({
    ...options,
    sleep: async () => { child.emit("exit", 1); },
  });
  assert.equal(handle.active, false);
  assert.match(handle.note ?? "", /退出码 1/);
});

test("缺省超时是 90 分钟", async () => {
  const child = fakeChild();
  const { options } = harness(child);
  const handle = await startSleepInhibit({ ...options, timeoutMs: undefined });
  assert.equal(new Date(handle.expiresAt ?? "").getTime() - 1_700_000_000_000, DEFAULT_INHIBIT_TIMEOUT_MS);
  await handle.stop();
});

test("withSleepInhibit：fn 抛错也必定释放", async () => {
  const child = fakeChild();
  const { lines, options } = harness(child);
  await assert.rejects(
    withSleepInhibit(options, async () => { throw new Error("签到炸了"); }),
    { message: "签到炸了" },
  );
  assert.equal(child.killed, 1, "异常路径也必须关闭");
  assert.ok(lines.some((line) => line.includes("防休眠已关闭")));
});

test("withSleepInhibit：options 为 null 时完全不激活", async () => {
  const child = fakeChild();
  const value = await withSleepInhibit(null, async () => "done");
  assert.equal(value, "done");
  assert.equal(child.killed, 0, "没有激活过，不该 kill 任何东西");
});
