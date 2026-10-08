/**
 * AnyRouter 站点适配器 —— 签到只需刷新控制台页面，无需退出重登。
 *
 * 与 AgentRouter 的关键差异：
 * - 无签到按钮、无 toast 提示，签到在页面加载时自动完成
 * - 公告是常驻区块（非弹窗），无需关闭
 * - 余额/消耗文案格式与 AgentRouter 相同
 */

import type { ReadableSite } from "./readable.ts";

export type PageText = string;

/** AnyRouter 适配器：满足只读能力接口，另带本站专用的登录态判定。 */
export type AnyRouterAdapter = ReadableSite & {
  domain: string;
  origin: string;
  classify: ReadableSite["classify"] & {
    /** 页面是否处于已登录状态（有控制台导航或问候语）。 */
    loggedIn: (text: PageText) => boolean;
    /** 提取问候语中的站点身份（"晚上好，linuxdo_85789"）。 */
    identity: (text: PageText) => string | null;
  };
};

function money(match: RegExpExecArray | null): number | null {
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** 问候语里的站点身份："👋晚上好，linuxdo_85789" → "linuxdo_85789"。 */
function greetingIdentity(text: PageText): string | null {
  const match = /(?:早上好|下午好|晚上好|你好)[，,]\s*(\S+)/.exec(text);
  return match ? match[1] : null;
}

export const anyRouter: AnyRouterAdapter = {
  id: "anyrouter",
  name: "AnyRouter",
  domain: "anyrouter.top",
  origin: "https://anyrouter.top",
  consoleUrl: "https://anyrouter.top/console",
  dailyCredit: 25,
  // 控制台正文比 AgentRouter 长（常驻公告区占了一大段），4000 会把余额截掉。
  textLimit: 6000,
  parse: {
    balance: (text) =>
      money(/当前余额\s*\$([\d,]+(?:\.\d+)?)/.exec(text)) ??
      money(/\bCurrent balance\s*\$([\d,]+(?:\.\d+)?)/i.exec(text)),
    totalSpent: (text) =>
      money(/历史消耗\s*\$([\d,]+(?:\.\d+)?)/.exec(text)) ??
      money(/\bConsumption\s*\$([\d,]+(?:\.\d+)?)/i.exec(text)),
  },
  classify: {
    loggedIn: (text) =>
      text.includes("控制台") || text.includes("Console") ||
      /(?:早上好|下午好|晚上好|你好)[，,]/.test(text),
    identity: greetingIdentity,
    // 登出态判据是"登录页特征出现 **且** 问候语消失"。只看登录链接会误判：
    // 已登录的控制台页顶部同样可能带"登录"字样的无关链接。
    loggedOut: (text) =>
      greetingIdentity(text) === null &&
      (/(?:使用\s*(?:GitHub|LinuxDO)\s*继续|Continue with (?:GitHub|LinuxDO))/.test(text) ||
        /(?:^|\s)(?:登\s*录|注册|Sign in|Log in)(?:\s|$)/.test(text)),
    manualIntervention: (text) => {
      for (const pattern of ["Sign in to GitHub", "Authorize", "Two-factor", "Verify", "device verification"]) {
        if (text.includes(pattern)) return pattern;
      }
      return null;
    },
    /**
     * 站点**不显示**"今日已签到"——签到在页面加载时静默完成，页面上没有任何状态提示
     * （实测：刷新前后正文无差异，无 toast、无徽标）。因此这里恒为 false，
     * "今天是否已到账"只能由账本 + 余额基线判断（见 anyrouter-checkin.ts）。
     * 返回 false 而不是抛错：只读路径（snapshot/recheck）会调它，恒 false 是正确答案。
     */
    alreadyCheckedIn: () => false,
  },
  // 问候语能精确取出身份，优先按它判等；取不到（页面未渲染完）再退回子串包含。
  identityMatches: (text, expectedIdentity) => {
    const found = greetingIdentity(text);
    return found !== null ? found === expectedIdentity : text.includes(expectedIdentity);
  },
};
