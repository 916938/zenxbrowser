/**
 * 站点适配器的**共用最小接口** —— `console.ts` / `snapshot.ts` / `recheck.ts`
 * 这三个只读能力需要的全部站点知识，仅此而已。
 *
 * 为什么单独抽一层而不直接复用 `SiteAdapter`：AgentRouter 的适配器带着一堆
 * 只有"退出重登"流程才用得上的判定（hasAnnouncement、loginRateLimited…），
 * AnyRouter 根本没有那些动作。只读路径要求的其实很少——能导航到控制台、
 * 能读余额与消耗、能判断登录/身份/已签到。把这个交集定义出来，
 * 两个站点就能共用同一套 snapshot / recheck，而不必互相迁就对方的流程。
 *
 * 只放**事实与判定**，不放流程（导航顺序、重试、窗口管理都不在这里）。
 */

export type PageText = string;

/** 只读观察所需的站点能力交集。两个站点的适配器都满足它。 */
export type ReadableSite = {
  /** 稳定标识，同时是账本 alias 的站点后缀（见 db.ts 的 ledgerAliasOf）。 */
  id: string;
  name: string;
  /** 控制台地址：登录身份、当前余额、历史消耗所在页。 */
  consoleUrl: string;
  /** 站点每日签到发放的额度，用于"相对基线是否已发放"的判定。 */
  dailyCredit: number;
  /**
   * 读取页面正文时的截断长度。站点页面长度差异很大，取值过小会把余额截掉
   * （AgentRouter 4000 够用，AnyRouter 的公告区很长，需要 6000）。
   */
  textLimit: number;
  parse: {
    /** "当前余额 $X"；页面没渲染出来返回 null（不算失败）。 */
    balance: (text: PageText) => number | null;
    /** "历史消耗 $X"，站点累计值，差分才是区间消耗。 */
    totalSpent: (text: PageText) => number | null;
  };
  classify: {
    /** 处于登出态。 */
    loggedOut: (text: PageText) => boolean;
    /** 需要人工处理的页面特征（OAuth 授权页、两步验证等）；返回命中特征或 null。 */
    manualIntervention: (text: PageText) => string | null;
    /** 站点显示"今日已签到"。 */
    alreadyCheckedIn: (text: PageText) => boolean;
  };
  /**
   * 页面正文里该账号的登录身份是否出现。
   *
   * 不写成"取出身份再比较"：AgentRouter 的身份散在 VOM 的多个节点里，
   * 可靠的做法是子串包含；AnyRouter 则能从问候语里精确取出。两者都能回答
   * "这是不是我要的账号"，所以接口按这个问题定义，让各站点用自己最可靠的方式实现。
   */
  identityMatches: (text: PageText, expectedIdentity: string) => boolean;
};
