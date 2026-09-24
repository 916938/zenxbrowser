import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichBskTimeout } from "../src/diagnose.ts";
import { ZenxError } from "../src/core.ts";
import type { Browser, Runner } from "../src/core.ts";

const edge: Browser = {
  instance_id: "aaaa1111",
  browser_name: "Edge",
  browser_version: "140.0",
  extension_version: "0.2.3",
  label: "Edge#aaaa",
  extension_protocol_version: "1.3",
  version_skew: false,
};

const timeout = () => new ZenxError("BSK_TIMEOUT", "bsk 调用超时，已终止本次子进程；远端操作可能已生效，不会自动重试。");

test("非 BSK_TIMEOUT 错误原样通过，不浪费一次列举", async () => {
  const original = new ZenxError("IDENTITY_MISMATCH", "身份不符。");
  const run: Runner = () => Promise.reject(new Error("不应调用 bsk"));
  assert.equal(await enrichBskTimeout(original, run), original);
});

test("实例仍能列出但操作超时：诊断为扩展卡死并给出关窗建议", async () => {
  const run: Runner = () => Promise.resolve({ stdout: JSON.stringify([edge]), exitCode: 0 });
  const enriched = await enrichBskTimeout(timeout(), run, { instanceId: "aaaa1111" });
  assert.ok(enriched instanceof ZenxError);
  assert.equal(enriched.code, "BSK_TIMEOUT");
  assert.match(enriched.message, /仍能列出/);
  assert.match(enriched.message, /扩展疑似卡死/);
});

test("实例不在列表中：提示可能已退出或实例 ID 已变化", async () => {
  const run: Runner = () => Promise.resolve({ stdout: "[]", exitCode: 0 });
  const enriched = await enrichBskTimeout(timeout(), run, { instanceId: "aaaa1111" });
  assert.ok(enriched instanceof ZenxError);
  assert.match(enriched.message, /不在连接列表中/);
});

test("连 bsk browsers 都超时：诊断为 daemon 卡死", async () => {
  const run: Runner = () => Promise.reject(new ZenxError("BSK_TIMEOUT", "bsk 调用超时"));
  const enriched = await enrichBskTimeout(timeout(), run, { instanceId: "aaaa1111" });
  assert.ok(enriched instanceof ZenxError);
  assert.match(enriched.message, /daemon 疑似卡死/);
  assert.match(enriched.message, /bsk daemon restart/);
});

test("已含诊断的错误不重复追加", async () => {
  const once = await enrichBskTimeout(timeout(), async () => ({ stdout: JSON.stringify([edge]), exitCode: 0 }), { instanceId: "aaaa1111" });
  const twice = await enrichBskTimeout(once, async () => ({ stdout: "[]", exitCode: 0 }), { instanceId: "aaaa1111" });
  assert.equal(twice, once, "二次经过应原样返回");
});

test("只有 home+alias 时能从绑定里查出实例 ID", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zenx-diagnose-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [{ alias: "alpha", instanceId: "aaaa1111", expectedIdentity: "github_1", boundAt: "2026-09-13T00:00:00Z" }],
  }));
  const run: Runner = () => Promise.resolve({ stdout: JSON.stringify([edge]), exitCode: 0 });
  const enriched = await enrichBskTimeout(timeout(), run, { home, alias: "alpha" });
  assert.ok(enriched instanceof ZenxError);
  assert.match(enriched.message, /仍能列出/);
});
