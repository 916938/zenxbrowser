import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginAccount } from "../src/login.ts";
import { ZenxError } from "../src/core.ts";
import type { Account, Browser, Runner, RunnerOptions, Result } from "../src/core.ts";

const edge: Browser = {
  instance_id: "exact-instance", browser_name: "Edge", browser_version: "140.0",
  extension_version: "0.2.3", label: "Edge#exac", extension_protocol_version: "1.3", version_skew: false,
};
const account: Account = { alias: "work", instanceId: edge.instance_id, expectedIdentity: "github_16350", boundAt: "2026-09-13T00:00:00Z" };

const loggedInText = "Agent Router 15 G github_16350 CONSOLE 当前余额 $655.18 历史消耗 $3104.82";
const rateLimitedText = "登 录 使用 GitHub 继续 使用 LinuxDO 继续 登录次数过多，请稍后再试";
const manualText = "Sign in to GitHub Authorize";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-login-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [account] }));
  return home;
}

/**
 * 按页面正文脚本化：classify 决定"首次读到的页面正文"，第二次起返回目标已登录态，
 * 用来覆盖登录成功后轮询命中的路径。
 */
function runnerFor(firstText: string, secondText = loggedInText): Runner {
  const result = (value: unknown): Result => ({ stdout: JSON.stringify(value), exitCode: 0 });
  let reads = 0;
  return (args: string[], _options?: RunnerOptions) => {
    if (args[0] === "browsers") return Promise.resolve(result([edge]));
    if (args[0] === "session" && args[1] === "start") return Promise.resolve(result({ session_id: "abcd" }));
    if (args[0] === "evaluate") {
      // 页面正文读取：第一次返回脚本化正文，之后返回"已登录"或保持限流。
      if (typeof args[1] === "string" && args[1].includes("innerText")) {
        reads += 1;
        return Promise.resolve(result({ ok: true, value: reads === 1 ? firstText : secondText }));
      }
      return Promise.resolve(result({ ok: true, value: { clicked: true } }));
    }
    if (args[0] === "observe") return Promise.resolve({ stdout: '@vom 1\n  @e12 button "github_logo 使用 GitHub 继续"\n', exitCode: 0 });
    return Promise.resolve(result({ ok: true, value: {} }));
  };
}

const fastDeps = {
  now: () => 0,
  sleep: async () => undefined,
};

test("login: 已登录时原样返回，不做任何点击", async (t) => {
  const home = await fixture(t);
  const calls: string[][] = [];
  const spy: Runner = (args, options) => { calls.push(args); return runnerFor(loggedInText)(args, options); };
  const result = await loginAccount(home, spy, "work", 60_000, fastDeps);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyLoggedIn, true);
  assert.equal(result.balance, 655.18);
  assert.ok(!calls.some((args) => args[0] === "click"), "已登录不应点击任何元素");
});

test("login: 站点限流时抛 LOGIN_RATE_LIMITED，不消耗更多登录尝试", async (t) => {
  const home = await fixture(t);
  const limited: Runner = (args, options) => runnerFor(rateLimitedText, rateLimitedText)(args, options);
  await assert.rejects(
    loginAccount(home, limited, "work", 60_000, fastDeps),
    (error: unknown) => error instanceof ZenxError && error.code === "LOGIN_RATE_LIMITED",
  );
});

test("login: GitHub 授权页需要人工处理", async (t) => {
  const home = await fixture(t);
  const manual: Runner = (args, options) => runnerFor(manualText)(args, options);
  await assert.rejects(
    loginAccount(home, manual, "work", 60_000, fastDeps),
    (error: unknown) => error instanceof ZenxError && error.code === "MANUAL_INTERVENTION_REQUIRED",
  );
});

test("login: 账号离线时只报告，不启动 Edge", async (t) => {
  const home = await fixture(t);
  const offline: Runner = () => Promise.resolve({ stdout: "[]", exitCode: 0 });
  const result = await loginAccount(home, offline, "work", 60_000, fastDeps);
  assert.equal(result.ok, false);
  assert.equal(result.connection, "offline");
  assert.equal(result.code, "OFFLINE");
});
