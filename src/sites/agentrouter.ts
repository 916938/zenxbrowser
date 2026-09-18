/**
 * AgentRouter 站点适配器 —— 关于这个站点的**全部**知识都放在这里。
 *
 * 为什么要抽出来：站点专属事实（控制台地址、页面文案特征、余额/消耗正则、
 * tab 域名匹配）原先散落在 console.ts / site.ts / login.ts / checkin.ts 四处，
 * 同一个"已签到"特征就写了三份，改一处漏一处。现在这里是唯一来源，
 * 核心流程只依赖本文件导出的接口，将来接第二个站点不用改流程。
 *
 * 只放**事实与判定**，不放流程（导航顺序、重试、窗口管理都不在这里）。
 */

/** 页面可见正文 → 站点语义。所有判定只读入参，不做 IO。 */
export type PageText = string;

export type SiteAdapter = {
  /** 稳定标识，用于 CLI / 报表 / 日志。 */
  id: string;
  name: string;
  /** tab 域名匹配的权威依据。**精确匹配**，不含子域。 */
  domain: string;
  origin: string;
  /** 控制台地址：登录身份、当前余额、历史消耗所在页。 */
  consoleUrl: string;
  /** 签到会退出重登，会改变站点状态——不是只读操作。 */
  mutating: boolean;
  parse: {
    /** "当前余额 $X" / "Current balance $X"；页面没渲染出来返回 null（不算失败）。 */
    balance: (text: PageText) => number | null;
    /** "历史消耗 $X" / "Consumption $X"，站点累计值，差分才是区间消耗。 */
    totalSpent: (text: PageText) => number | null;
  };
  classify: {
    /** 站点显示"今日已签到"。刻意不认"签到成功"（动作提示，不代表额度已发放）。 */
    alreadyCheckedIn: (text: PageText) => boolean;
    /** 只读观察用的宽松特征：命中即提示，不作为到账结论。 */
    checkedInSignals: (text: PageText) => string[];
    /** 页面上存在"签到"类可点击动作。 */
    checkinActionSignals: (text: PageText) => string[];
    /** GitHub 授权/验证页等需要人工的特征；返回命中的特征或 null。 */
    manualIntervention: (text: PageText) => string | null;
    /** 站点登录限流（共享配额，不是账号问题）；返回命中的特征或 null。 */
    loginRateLimited: (text: PageText) => string | null;
    /** 处于登出态。 */
    loggedOut: (text: PageText) => boolean;
    /** 存在需要关闭的系统公告。 */
    hasAnnouncement: (text: PageText) => boolean;
  };
};

// ---------------------------------------------------------------------------
// 文案特征
//
// 站点界面语言随账号而异（实测同一站点有的号是中文、有的是英文），
// 两种都必须认，否则另一批账号永远读不到余额/状态。
// ---------------------------------------------------------------------------

/** 刻意不含"签到成功"：那是动作提示，重复登录也会出现，不能当状态。 */
const ALREADY_CHECKED_IN_PATTERNS = [
  "已签到", "已打卡", "今日已签到", "今日已打卡",
  "checked in", "already checked in",
];

/** 只读观察用（inspect-site）：这里可以宽松些，命中只是提示。 */
const CHECKED_IN_SIGNALS = [
  "已签到", "已打卡", "今日已签到", "签到成功", "打卡成功",
  "checked in", "already checked in",
];

const CHECKIN_ACTION_SIGNALS = [
  "每日签到", "每日打卡", "立即签到", "今日签到",
  "check in", "check-in", "daily check",
];

const MANUAL_INTERVENTION_PATTERNS = [
  "Sign in to GitHub", "Authorize", "Two-factor", "Verify", "device verification",
];

const LOGIN_RATE_LIMIT_PATTERNS = [
  "登录次数过多", "登录过于频繁", "操作过于频繁", "请求过于频繁", "请稍后再试",
  "too many login attempts", "too many attempts", "rate limit", "rate limited", "try again later",
];

function hits(text: PageText, patterns: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return patterns.filter((pattern) => lower.includes(pattern.toLowerCase()));
}

function firstHit(text: PageText, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (text.includes(pattern)) return pattern;
  }
  return null;
}

function money(match: RegExpExecArray | null): number | null {
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

export const agentRouter: SiteAdapter = {
  id: "agentrouter",
  name: "AgentRouter",
  domain: "agentrouter.org",
  origin: "https://agentrouter.org",
  consoleUrl: "https://agentrouter.org/console",
  mutating: true,
  parse: {
    balance: (text) =>
      money(/当前余额\s*\$([\d,]+(?:\.\d+)?)/.exec(text)) ??
      money(/\bCurrent balance\s*\$([\d,]+(?:\.\d+)?)/i.exec(text)),
    totalSpent: (text) =>
      money(/历史消耗\s*\$([\d,]+(?:\.\d+)?)/.exec(text)) ??
      money(/\bConsumption\s*\$([\d,]+(?:\.\d+)?)/i.exec(text)),
  },
  classify: {
    alreadyCheckedIn: (text) => hits(text, ALREADY_CHECKED_IN_PATTERNS).length > 0,
    checkedInSignals: (text) => hits(text, CHECKED_IN_SIGNALS),
    checkinActionSignals: (text) => hits(text, CHECKIN_ACTION_SIGNALS),
    manualIntervention: (text) => firstHit(text, MANUAL_INTERVENTION_PATTERNS),
    loginRateLimited: (text) => {
      const lower = text.toLowerCase();
      for (const pattern of LOGIN_RATE_LIMIT_PATTERNS) {
        if (lower.includes(pattern.toLowerCase())) return pattern;
      }
      return null;
    },
    loggedOut: (text) =>
      text.includes("注销成功") || (text.includes("登 录") && text.includes("使用 GitHub 继续")),
    hasAnnouncement: (text) =>
      text.includes("系统公告") && (text.includes("今日关闭") || text.includes("关闭公告")),
  },
};
