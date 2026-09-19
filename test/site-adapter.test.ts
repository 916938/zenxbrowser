import assert from "node:assert/strict";
import test from "node:test";
import { agentRouter } from "../src/sites/agentrouter.ts";

const CN = "控制台 15 G github_16350 CONSOLE Dashboard 账户数据 当前余额 $1187.41 历史消耗 $1412.59";
const EN =
  "Agent Router Home Console Docs 15 G github_16350 CONSOLE Dashboard " +
  "Account Data Current balance $1187.41 Consumption $1412.59 Usage Statistics";

test("balance 同时认中文与英文界面", () => {
  assert.equal(agentRouter.parse.balance(CN), 1187.41);
  assert.equal(agentRouter.parse.balance(EN), 1187.41);
  assert.equal(agentRouter.parse.balance("没有余额信息"), null);
});

test("totalSpent 同时认中文与英文界面", () => {
  assert.equal(agentRouter.parse.totalSpent(CN), 1412.59);
  assert.equal(agentRouter.parse.totalSpent(EN), 1412.59);
  assert.equal(agentRouter.parse.totalSpent("没有消耗信息"), null);
});

test("金额为 0 也算读到了（上层自行决定是否当缺失）", () => {
  assert.equal(agentRouter.parse.balance("当前余额 $0"), 0);
});

test("千分位与小数", () => {
  assert.equal(agentRouter.parse.balance("当前余额 $1,234.56"), 1234.56);
});

test("alreadyCheckedIn 不把'签到成功'当状态", () => {
  assert.equal(agentRouter.classify.alreadyCheckedIn("签到成功"), false);
  assert.equal(agentRouter.classify.alreadyCheckedIn("今日已签到"), true);
  assert.equal(agentRouter.classify.alreadyCheckedIn("Already checked in"), true);
});

test("checkedInSignals 是宽松提示，可以包含'签到成功'", () => {
  assert.deepEqual(agentRouter.classify.checkedInSignals("签到成功"), ["签到成功"]);
  assert.ok(agentRouter.classify.checkinActionSignals("每日签到").includes("每日签到"));
});

test("manualIntervention 识别 GitHub 授权页", () => {
  assert.equal(agentRouter.classify.manualIntervention("Sign in to GitHub"), "Sign in to GitHub");
  assert.equal(agentRouter.classify.manualIntervention("Two-factor authentication"), "Two-factor");
  assert.equal(agentRouter.classify.manualIntervention(CN), null);
});

test("loginRateLimited 中英文都认", () => {
  assert.equal(agentRouter.classify.loginRateLimited("登录次数过多"), "登录次数过多");
  assert.equal(agentRouter.classify.loginRateLimited("Too many login attempts"), "too many login attempts");
  assert.equal(agentRouter.classify.loginRateLimited(CN), null);
});

test("loggedOut 需要两个特征同时成立", () => {
  assert.equal(agentRouter.classify.loggedOut("注销成功"), true);
  assert.equal(agentRouter.classify.loggedOut("登 录 使用 GitHub 继续"), true);
  assert.equal(agentRouter.classify.loggedOut("登 录"), false);
  assert.equal(agentRouter.classify.loggedOut(CN), false);
  // 英文界面的登录页没有"登 录 / 使用 GitHub 继续"，只有 Continue with GitHub。
  assert.equal(agentRouter.classify.loggedOut("Continue with GitHub"), true);
});

test("hasAnnouncement 需要公告与关闭动作同时出现", () => {
  assert.equal(agentRouter.classify.hasAnnouncement("系统公告 今日关闭"), true);
  assert.equal(agentRouter.classify.hasAnnouncement("系统公告"), false);
});

test("hasAnnouncement 认英文公告：漏判会让弹窗遮住身份与余额", () => {
  assert.equal(agentRouter.classify.hasAnnouncement('dialog "System Notice" button "Close Today"'), true);
  assert.equal(agentRouter.classify.hasAnnouncement('dialog "System Notice" button "Close Notice"'), true);
  assert.equal(agentRouter.classify.hasAnnouncement("System Notice"), false, "只有公告没有关闭动作不算");
});

test("适配器元数据可用于域名路由", () => {
  assert.equal(agentRouter.domain, "agentrouter.org");
  assert.equal(agentRouter.consoleUrl, "https://agentrouter.org/console");
  assert.equal(agentRouter.mutating, true, "签到会改变站点状态，不是只读");
});
