import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeAccountId, readProfileAccount } from "../src/profile-account.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "zenx-profile-account-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function writeProfile(userDataDir: string, profileDirectory: string, preferences: unknown) {
  await mkdir(join(userDataDir, profileDirectory), { recursive: true });
  await writeFile(join(userDataDir, profileDirectory, "Preferences"), JSON.stringify(preferences), "utf8");
}

test("normalizeAccountId 只接受十六进制账号 ID", () => {
  assert.equal(normalizeAccountId("9B28B8F770BFE675"), "9b28b8f770bfe675");
  for (const bad of ["", "  ", "abc", "xyz12345", "user@example.com", 42, null, undefined, {}, []]) {
    assert.equal(normalizeAccountId(bad), "", `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("读取 Preferences 的 account_id 与 profile.name", async (t) => {
  const home = await fixture(t);
  await writeProfile(home, "Profile 3", {
    account_info: { account_id: "349ef2e021faa0fa", email: "soft@lawia.org", gaia: "349ef2e021faa0fa" },
    profile: { name: "916938 13" },
  });
  const result = await readProfileAccount(home, "Profile 3");
  assert.deepEqual(result, { accountId: "349ef2e021faa0fa", profileName: "916938 13" });
});

test("account_id 缺失时回退 edge_account_cid / gaia", async (t) => {
  const home = await fixture(t);
  await writeProfile(home, "Default", {
    account_info: { edge_account_cid: "aaaaaaaaaaaaaaaa", email: "ignored@example.com" },
    profile: { name: "3" },
  });
  assert.equal((await readProfileAccount(home, "Default")).accountId, "aaaaaaaaaaaaaaaa");

  await writeProfile(home, "Profile 2", { account_info: { gaia: "bbbbbbbbbbbbbbbb" } });
  assert.equal((await readProfileAccount(home, "Profile 2")).accountId, "bbbbbbbbbbbbbbbb");
});

test("account_info 为数组时同样取到账号 ID", async (t) => {
  const home = await fixture(t);
  await writeProfile(home, "Profile 1", {
    account_info: [{ account_id: "4b1d62601471e220", email: "ignored@example.com" }],
    profile: { name: "1" },
  });
  assert.equal((await readProfileAccount(home, "Profile 1")).accountId, "4b1d62601471e220");
});

test("数组里出现多个不同账号 ID → 返回空，不猜", async (t) => {
  const home = await fixture(t);
  await writeProfile(home, "Profile 7", {
    account_info: [
      { account_id: "1111111111111111" },
      { account_id: "2222222222222222" },
    ],
  });
  assert.equal((await readProfileAccount(home, "Profile 7")).accountId, "");
});

test("数组里重复同一账号 ID → 视为唯一", async (t) => {
  const home = await fixture(t);
  await writeProfile(home, "Profile 8", {
    account_info: [{ account_id: "3333333333333333" }, { account_id: "3333333333333333" }],
  });
  assert.equal((await readProfileAccount(home, "Profile 8")).accountId, "3333333333333333");
});

test("未登录 / 无 account_info 时返回空锚点", async (t) => {
  const home = await fixture(t);
  await writeProfile(home, "Profile 5", { profile: { name: "x" } });
  assert.deepEqual(await readProfileAccount(home, "Profile 5"), { accountId: "", profileName: "x" });
});

test("读取失败一律返回空锚点，不抛错", async (t) => {
  const home = await fixture(t);
  assert.deepEqual(await readProfileAccount(home, "Missing"), { accountId: "", profileName: "" });
  await writeProfile(home, "Broken", {});
  await writeFile(join(home, "Broken", "Preferences"), "{ not json", "utf8");
  assert.deepEqual(await readProfileAccount(home, "Broken"), { accountId: "", profileName: "" });
});

test("拒绝越界的 Profile 子目录名", async (t) => {
  const home = await fixture(t);
  for (const directory of ["..", "a\\b", "a/b", "  ", ""]) {
    assert.deepEqual(await readProfileAccount(home, directory), { accountId: "", profileName: "" }, `应拒绝 ${JSON.stringify(directory)}`);
  }
});

test("不读取 Preferences 里的私密字段", async (t) => {
  const home = await fixture(t);
  await writeProfile(home, "Profile 9", {
    account_info: { account_id: "cccccccccccccccc", email: "secret@example.com" },
    profile: { name: "n" },
  });
  const result = await readProfileAccount(home, "Profile 9");
  assert.deepEqual(Object.keys(result).sort(), ["accountId", "profileName"]);
  assert.equal(JSON.stringify(result).includes("secret@example.com"), false);
});
