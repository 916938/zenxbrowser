/**
 * 从 Edge 窗口标题反推 Profile 序号。
 *
 * Edge 的窗口标题形如 `<页面标题> - <Profile 序号> - Microsoft Edge`，实测 Profile 8
 * 的窗口是 "New tab - 8 - Microsoft​ Edge"。"Microsoft" 后可能带零宽字符，故用宽松匹配。
 * 这是目前唯一能从外部可靠区分"哪个浏览器实例属于哪个 Profile"的信号——扩展不暴露
 * Profile 路径，`chrome://version` 也被 CDP 拒绝访问。
 */

/** 从单个窗口标题里取出 Profile 段；取不到返回 null。 */
export function extractProfileMarker(title: string): string | null {
  const match = /-\s*([^-]+?)\s*-\s*Microsoft/.exec(title);
  if (!match) return null;
  const marker = match[1].trim().toLowerCase();
  return marker === "" ? null : marker;
}

/**
 * 对比前后两次窗口标题快照，找出新出现窗口所属的 Profile。
 * 用多重集差集比较（同一标题可能开多个窗口）。
 */
export function markerFromTitles(before: string[], after: string[]): string | null {
  const counts = new Map<string, number>();
  for (const title of before) counts.set(title, (counts.get(title) ?? 0) + 1);
  const fresh: string[] = [];
  for (const title of after) {
    const left = counts.get(title) ?? 0;
    if (left > 0) counts.set(title, left - 1);
    else fresh.push(title);
  }
  const markers = new Set<string>();
  for (const title of fresh) {
    const marker = extractProfileMarker(title);
    if (marker) markers.add(marker);
  }
  // 新窗口可能不止一个（浏览器会恢复上次的窗口），Profile 必须唯一，否则不敢判定。
  return markers.size === 1 ? [...markers][0] : null;
}

/**
 * 账号配置的 Profile 目录对应的标题标记。
 * Default 在 Edge 里既可能显示 "Default" 也可能显示序号 1，两种都接受。
 */
export function expectedMarkers(profileDirectory: string): string[] {
  const name = profileDirectory.trim().toLowerCase();
  if (name === "default") return ["default", "1"];
  const numbered = /^profile\s*(\d+)$/.exec(name);
  return numbered ? [numbered[1]] : [name];
}

/** 判断探测到的标记是否对得上账号配置的 Profile。 */
export function markerMatches(marker: string | null, profileDirectory: string): boolean {
  if (!marker) return false;
  const normalized = marker.trim().toLowerCase();
  return expectedMarkers(profileDirectory).includes(normalized);
}
