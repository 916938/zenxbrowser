import { readFile } from "node:fs/promises";
import { win32 } from "node:path";

/**
 * 从 Edge Profile 目录读出稳定的账号锚点。
 *
 * `Preferences` 的 `account_info.account_id` 是浏览器为每个已登录账号分配的
 * 不透明 ID（本机实测 16 位十六进制），跨 Edge 重启稳定、各 Profile 互不相同，
 * 且**不是**邮箱、姓名或任何凭证——正好用来把「Profile 子目录 ↔ 浏览器实例」
 * 对上，而不用碰 `Profile 显示名` 这种会被用户改名、还会重名的东西。
 *
 * 只读两个字段（account_info.account_id / profile.name），不读 Cookie、
 * 不读 token、不读密码；解析失败一律返回空而不是抛错，交给调用方降级。
 */

/** 只读采集到的账号锚点；读不到时字段为空串。 */
export type ProfileAccount = {
  /** `account_info.account_id`，已登录账号的不透明 ID。 */
  accountId: string;
  /** `profile.name`，Profile 显示名（仅供参考，可能重名）。 */
  profileName: string;
};

export const EMPTY_PROFILE_ACCOUNT: ProfileAccount = { accountId: "", profileName: "" };

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{8,64}$/i;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 校验并规整 account_id；非法值一律视为"读不到"。 */
export function normalizeAccountId(value: unknown): string {
  const id = clean(value).toLowerCase();
  return ACCOUNT_ID_PATTERN.test(id) ? id : "";
}

/**
 * 读取 `<userDataDir>/<profileDirectory>/Preferences` 的账号锚点。
 *
 * 任何读取/解析失败都返回空锚点：定位失败时宁可报"无法确定"，也不猜。
 */
export async function readProfileAccount(
  userDataDir: string,
  profileDirectory: string,
): Promise<ProfileAccount> {
  if (!userDataDir.trim() || !profileDirectory.trim()) return { ...EMPTY_PROFILE_ACCOUNT };
  // Profile 子目录名必须是单层名字，避免拼出越界路径。
  if (/[\\/]/.test(profileDirectory.trim()) || profileDirectory.trim() === "..") {
    return { ...EMPTY_PROFILE_ACCOUNT };
  }
  const file = win32.join(userDataDir.trim(), profileDirectory.trim(), "Preferences");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { ...EMPTY_PROFILE_ACCOUNT };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...EMPTY_PROFILE_ACCOUNT };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_PROFILE_ACCOUNT };
  }
  const root = value as Record<string, unknown>;
  const profile = root.profile;
  const profileNode = profile !== null && typeof profile === "object" && !Array.isArray(profile)
    ? profile as Record<string, unknown>
    : {};
  return {
    accountId: pickAccountId(root.account_info),
    profileName: clean(profileNode.name).slice(0, 200),
  };
}

function idOf(entry: Record<string, unknown>): string {
  return normalizeAccountId(entry.account_id ?? entry.edge_account_cid ?? entry.gaia);
}

/**
 * 取出账号 ID。`account_info` 在不同 Profile 里形状不同：有的是单个对象，
 * 有的是数组（本机两种都能遇到）。数组里若有多个**不同**账号 ID，说明
 * 这个文件不足以确定归属，返回空让调用方降级——宁可报"无法确定"，也不猜。
 */
function pickAccountId(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    const ids = new Set<string>();
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const id = idOf(entry as Record<string, unknown>);
      if (id) ids.add(id);
    }
    return ids.size === 1 ? [...ids][0] : "";
  }
  return idOf(value as Record<string, unknown>);
}
