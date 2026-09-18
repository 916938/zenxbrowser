import assert from "node:assert/strict";
import test from "node:test";
import { ZenxError } from "../src/core.ts";
import { hintedCodes, hintFor } from "../src/hints.ts";

test("未登记的错误码没有 hint（宁可少说，不说错）", () => {
  assert.equal(hintFor(new ZenxError("TOTALLY_UNKNOWN_CODE", "x")), null);
  assert.equal(new ZenxError("TOTALLY_UNKNOWN_CODE", "x").hint, undefined);
});

/** 模板占位符形如 {alias}；代码里的 {a:true} 之类不算。 */
const PLACEHOLDER = /\{[a-zA-Z_]\w*\}/;

test("无变量的 hint 直接给出", () => {
  const error = new ZenxError("STORE_BUSY", "账号锁残留。");
  assert.ok(error.hint);
  assert.match(error.hint, /rmSync/);
  assert.doesNotMatch(error.hint, PLACEHOLDER, "不得残留未替换的占位符");
});

test("有变量的 hint 用 details 填充", () => {
  const error = new ZenxError("PROFILE_NOT_FOUND", "没找到。", { alias: "edge-8" });
  assert.match(error.hint ?? "", /zenx accounts ensure-online edge-8/);
  assert.doesNotMatch(error.hint ?? "", PLACEHOLDER);
});

test("缺变量时整条省略，不输出半成品", () => {
  const missing = new ZenxError("PROFILE_NOT_FOUND", "没找到。");
  assert.equal(missing.hint, undefined);

  const empty = new ZenxError("PROFILE_NOT_FOUND", "没找到。", { alias: "  " });
  assert.equal(empty.hint, undefined);

  const nullish = new ZenxError("PROFILE_NOT_FOUND", "没找到。", { alias: null });
  assert.equal(nullish.hint, undefined);
});

test("数组变量渲染成逗号分隔", () => {
  const error = new ZenxError("AMBIGUOUS_SITE_TABS", "多个候选。", { candidateTabIds: [11, 12] });
  assert.match(error.hint ?? "", /11, 12/);
});

test("hint 里出现的命令都真实存在", () => {
  // 防 hint 里写出不存在的子命令。这里只覆盖 zenx 自有的命令名。
  // 与 src/cli.ts 帮助文本里列出的子命令保持一致（改命令名时这里也要改）。
  const known = new Set([
    "zenx accounts bind", "zenx accounts check", "zenx accounts checkin", "zenx accounts checkin-all",
    "zenx accounts close", "zenx accounts configure-launch", "zenx accounts ensure-online",
    "zenx accounts inspect-site", "zenx accounts login", "zenx accounts open-site",
    "zenx accounts recheck", "zenx accounts relink-account", "zenx accounts snapshot", "zenx doctor",
  ]);
  for (const code of hintedCodes()) {
    const error = new ZenxError(code, "m", { alias: "a", candidateTabIds: [1] });
    const hint = error.hint;
    if (!hint) continue;
    for (const m of hint.matchAll(/zenx (?:accounts )?[a-z-]+/g)) {
      const candidate = m[0];
      assert.ok(
        [...known].some((k) => k.startsWith(candidate)),
        `${code}: hint 引用了未知命令 ${candidate}`,
      );
    }
  }
});

test("每个已登记 hint 都能在给定完整 details 时渲染出来", () => {
  for (const code of hintedCodes()) {
    const error = new ZenxError(code, "m", { alias: "edge-1", candidateTabIds: [7] });
    assert.ok(error.hint, `${code} 在完整 details 下仍没有 hint`);
    assert.doesNotMatch(error.hint, PLACEHOLDER, `${code} 残留占位符`);
  }
});
