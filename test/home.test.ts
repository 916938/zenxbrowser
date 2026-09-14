import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOME, resolveHome } from "../src/cli.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("默认数据目录在 CLI 所在项目内", () => {
  assert.equal(resolve(DEFAULT_HOME), resolve(root, ".zenx"));
});

test("目录优先级为显式选项、测试依赖、环境变量", () => {
  assert.equal(resolveHome("explicit", "injected", "environment"), resolve("explicit"));
  assert.equal(resolveHome(undefined, "injected", "environment"), resolve("injected"));
  assert.equal(resolveHome(undefined, undefined, "environment"), resolve("environment"));
});

test("从项目外调用也使用项目内目录且不创建文件", () => {
  const env = { ...process.env };
  delete env.ZENX_HOME;
  const script = `import { resolveHome } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)}; process.stdout.write(resolveHome());`;
  for (const cwd of [root, tmpdir()]) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd, env, encoding: "utf8" });
    assert.equal(output, resolve(root, ".zenx"));
  }
});

test("ZENX_HOME 在项目外调用时仍可覆盖默认值", () => {
  const expected = join(tmpdir(), "zenx-home-override");
  const script = `import { resolveHome } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)}; process.stdout.write(resolveHome());`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: tmpdir(), env: { ...process.env, ZENX_HOME: expected }, encoding: "utf8" });
  assert.equal(output, resolve(expected));
});
