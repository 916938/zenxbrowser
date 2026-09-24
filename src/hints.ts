/**
 * 错误码 → 可执行的下一步建议。
 *
 * 为什么集中在这里：同一个错误在不同调用点需要不同的上下文（别名、实例 ID、
 * 候选标签），写死在 throw 处要么丢失上下文，要么把消息拼得很长。这里用
 * "模板 + details 变量"解决——throw 处只管填 details，hint 由本表合成。
 *
 * 原则：
 * - hint 必须是**可执行的下一步**（命令、动作），不是复述错误。
 * - 模板里的 `{name}` 用 error.details 的同名字段替换；取不到就整条省略，
 *   绝不输出半成品（如"运行 zenx accounts ensure-online "）。
 * - 没有登记的 code 返回 null，调用方不输出 hint 字段。宁可少说，不说错。
 */

import type { ZenxError } from "./core.ts";

/** 模板 + 该模板需要的变量名。 */
type HintTemplate = { text: string; vars?: readonly string[] };

const HINTS: Record<string, HintTemplate> = {
  // --- 实例定位 ---
  ACCOUNT_NOT_FOUND: {
    text: "别名不存在。先用 zenx accounts check 列出已绑定账号，确认别名拼写；未绑定的先用 zenx accounts bind <别名> --instance-id <ID> --expected-identity <站点身份> --confirm 绑定。",
  },
  ACCOUNT_ANCHOR_MISSING: {
    text: "该 Profile 的 Preferences 里读不到已登录账号 ID，通常是 Edge 没登录。先人工登录一次该 Profile，再跑 zenx accounts configure-launch <别名> ... 重记锚点。",
  },
  PROFILE_AMBIGUOUS: {
    text: "同一 Profile 开了多个 Edge 进程，无法判定改绑到哪个。先关掉多余的 Edge 窗口，只保留一个再重试。",
  },
  PROFILE_NOT_FOUND: {
    text: "该 Profile 的 Edge 没在线。先跑 zenx accounts ensure-online {alias} 拉起它，等扩展连上后重试。",
    vars: ["alias"],
  },
  INSTANCE_OFFLINE: {
    text: "实例未在线。先跑 zenx accounts ensure-online {alias}；若 Edge 重启过导致实例 ID 变了，用 zenx accounts relink-account {alias} --confirm 重新定位。",
    vars: ["alias"],
  },
  NO_EDGE_CONNECTED: {
    text: "当前没有在线且协议兼容的 Edge。启动目标 Profile 的 Edge 并等待扩展连接，或先跑 zenx accounts ensure-online <别名>。",
  },
  LAUNCH_NOT_CONFIGURED: {
    text: "该账号没配置启动路径。先跑 zenx accounts configure-launch {alias} --edge-path <msedge.exe> --user-data-dir <用户数据根目录> --profile-directory <Profile子目录> --confirm。",
    vars: ["alias"],
  },

  // --- 站点与签到 ---
  LOGIN_RATE_LIMITED: {
    text: "这是站点侧共享配额（同一出口 IP 连续登录触发），不是账号问题，立刻重试只会更糟。等待约 10 分钟后再跑；批量场景用 zenx accounts checkin-all --wait 12m 自动冷却重试。",
  },
  LOGIN_TIMEOUT: {
    text: "三种常见原因：① 窗口被隐藏/最小化（先激活该 Profile 的 Edge 窗口）② 站点限流（等约 10 分钟，见 LOGIN_RATE_LIMITED）③ GitHub 会话过期（人工登录一次）。可先跑 zenx accounts login {alias} 只补登录。",
    vars: ["alias"],
  },
  IDENTITY_MISMATCH: {
    text: "页面身份与绑定身份不符（且页面不是登录页），未执行退出。站点停在登录页时 checkin 会自动点“使用 GitHub 继续”登录，走到这里说明站点上登录的是别的账号：核对绑定身份或该 Profile 登录的站点账号。",
    vars: ["alias"],
  },
  LOGOUT_FAILED: {
    text: "多数是隐藏窗口导致——退出其实已生效，只是页面没跳转。先激活该 Profile 的 Edge 窗口再重跑；真失败时账号仍在登录态，可直接重跑。",
  },
  MANUAL_INTERVENTION_REQUIRED: {
    text: "撞上 GitHub 授权/验证页，只能人工完成一次登录。登录后重跑即可；如需先恢复登录态，用 zenx accounts login {alias}。",
    vars: ["alias"],
  },
  CHECKIN_UNCONFIRMED: {
    text: "流程跑完但余额没涨。用 zenx accounts recheck {alias} 核实——当天早些时候登录过的话，额度可能已在那时发放。",
    vars: ["alias"],
  },
  WINDOW_NOT_INTERACTIVE: {
    text: "隔离窗口没有真正绘制（最小化的窗口会丢弃全部输入）。先恢复该 Profile 的 Edge 窗口，不要最小化；计划任务脚本需先还原窗口。",
  },
  AMBIGUOUS_SITE_TABS: {
    text: "有多个匹配的站点标签，无法确定操作哪个。用 --tab-id <N> 明确指定（候选：{candidateTabIds}）。",
    vars: ["candidateTabIds"],
  },
  SITE_TAB_NOT_FOUND: {
    text: "指定的 --tab-id 不是本实例内匹配的站点标签，不会新建。用 zenx accounts inspect-site {alias} 看当前候选，或改用候选里的 ID。",
    vars: ["alias"],
  },
  SITE_INSPECT_FAILED: {
    text: "只读观察失败，未重试也未刷新页面。若该标签在扩展更新前就已加载，需要人工刷新一次再试。",
  },

  // --- 环境与配置 ---
  STORE_BUSY: {
    text: "账号锁 .zenx\\accounts.lock 残留（进程被中断所致）。用 node -e \"require('fs').rmSync('.zenx/accounts.lock',{recursive:true,force:true})\" 清掉——别用 PowerShell Remove-Item，它会走环境删除钩子、经常超时。",
  },
  INVALID_STORE: {
    text: "账号文件损坏或存在重复（alias 与 instanceId 都必须唯一）。手工检查 .zenx\\accounts.json，改完务必跑 zenx accounts check 验证。",
  },
  BSK_UNAVAILABLE: {
    text: "找不到 bsk 可执行文件。检查 ZENX_BSK_PATH 是否指向 bsk 本体（不是带参数的命令），或先跑 zenx doctor。",
  },
  BSK_TIMEOUT: {
    text: "单次 bsk 调用超过 60 秒被终止。同一账号反复出现多半是扩展或 daemon 卡死：先 zenx accounts check 看实例状态；实例在线却操作超时，关掉该 Profile 的 Edge 窗口（遗留实例可批量用 zenx accounts close-leftover --confirm）并 bsk daemon restart 后重试。",
  },
  UNSUPPORTED_PROTOCOL: {
    text: "扩展协议版本不兼容。把 bsk CLI、daemon 和浏览器扩展一起升级到匹配版本，再跑 zenx doctor 确认。",
  },
  NOT_EDGE: {
    text: "目标实例不是 Microsoft Edge。确认 --instance-id 取自 Edge 实例（用 bsk browsers 核对）。",
  },
  CLOSE_NOT_SUPPORTED: {
    text: "该实例的扩展不认识 browser.close。先用 bsk browsers 看 EXT 列：若显示的还是旧版本号，说明 daemon 仍持有更新扩展之前的旧注册（换了扩展构建后必须重启 daemon，否则新方法一概被当成 unknown_method）——先把该实例的 Edge 关掉，再跑 bsk daemon restart，确认 EXT 变成新版本后重试。",
  },
  CHECKIN_TIMEOUT: {
    text: "总预算（默认 3 分钟）耗尽。用 --timeout 放宽到 5 分钟；若卡顿在登录环节，多半是站点限流，见 LOGIN_RATE_LIMITED。",
  },
};

/** 把模板里的 {var} 换成 details 的值；缺任一必需变量则返回 null。 */
function render(template: HintTemplate, details: Record<string, unknown> | undefined): string | null {
  if (!template.vars || template.vars.length === 0) return template.text;
  const values: Record<string, string> = {};
  for (const name of template.vars) {
    const raw = details?.[name];
    if (raw === undefined || raw === null) return null;
    const text = Array.isArray(raw) ? raw.join(", ") : String(raw);
    if (text.trim() === "") return null;
    values[name] = text.trim();
  }
  return template.text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/**
 * 为错误合成可执行建议。取不到（未登记 / 缺变量）返回 null。
 */
export function hintFor(error: ZenxError): string | null {
  const template = HINTS[error.code];
  if (!template) return null;
  return render(template, error.details);
}

/** 已登记 hint 的错误码，供测试与文档核对。 */
export function hintedCodes(): string[] {
  return Object.keys(HINTS).sort();
}
