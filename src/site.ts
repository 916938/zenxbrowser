import { ZenxError } from "./core.ts";
import type { Runner } from "./core.ts";

const siteUrl = "https://agentrouter.org/";
type UserTab = { tab_id: number; window_id: number; title: string; url: string; active: boolean; scope: "user" };

export function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidOutput(): ZenxError {
  return new ZenxError("INVALID_BSK_OUTPUT", "bsk 用户标签响应不完整或不符合严格协议；停止操作，不新建、不回退到 session 或标签名称。请更新 CLI、daemon 和扩展。");
}

function json(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw invalidOutput(); }
}

function parseTabs(raw: string): UserTab[] {
  const value = json(raw);
  if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.tabs)) throw invalidOutput();
  const ids = new Set<number>();
  return value.tabs.map((item: unknown) => {
    if (!object(item) || !isTabId(item.tab_id) || !isTabId(item.window_id) || typeof item.title !== "string" ||
      typeof item.url !== "string" || typeof item.active !== "boolean" || item.scope !== "user") throw invalidOutput();
    if (ids.has(item.tab_id)) throw invalidOutput();
    ids.add(item.tab_id);
    try { new URL(item.url); }
    catch { throw invalidOutput(); }
    return { tab_id: item.tab_id, window_id: item.window_id, title: item.title, url: item.url, active: item.active, scope: "user" };
  });
}

function matchingOrigin(raw: string): string | undefined {
  const url = new URL(raw);
  if (!/^https?:\/\//i.test(raw) || /[\s\\]/.test(raw)) return;
  const authority = raw.slice(raw.indexOf("://") + 3).split(/[/?#]/)[0];
  if (authority.includes("@") || url.username || url.password || url.port || url.hostname !== "agentrouter.org" ||
    !["http:", "https:"].includes(url.protocol)) return;
  return url.origin;
}

type Candidate = UserTab & { origin: string };

function siteCandidates(tabs: UserTab[]): Candidate[] {
  return tabs.flatMap((tab) => {
    const origin = matchingOrigin(tab.url);
    return origin ? [{ ...tab, origin }] : [];
  });
}

function pickSiteTab(candidates: Candidate[], tabId: number | undefined): Candidate | undefined {
  if (tabId !== undefined) {
    const selected = candidates.find((tab) => tab.tab_id === tabId);
    if (!selected) throw new ZenxError("SITE_TAB_NOT_FOUND", "指定 --tab-id 不是该绑定实例内匹配 AgentRouter 的用户标签；不会新建。", { candidateTabIds: candidates.map((tab) => tab.tab_id) });
    return selected;
  }
  if (candidates.length <= 1) return candidates[0];
  const active = candidates.filter((tab) => tab.active);
  if (active.length !== 1) {
    const candidateTabIds = candidates.map((tab) => tab.tab_id);
    throw new ZenxError("AMBIGUOUS_SITE_TABS", `存在多个候选标签（${candidateTabIds.join(", ")}）；请用 --tab-id <N> 明确选择。`, { candidateTabIds });
  }
  return active[0];
}

async function listSiteTabs(run: Runner, instanceId: string, remaining: () => number): Promise<UserTab[]> {
  const reply = await run(["tab", "list", "--browser-id", instanceId, "--scope", "user", "--json"], {
    timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" },
  });
  remaining();
  if (reply.exitCode !== 0) throw new ZenxError("BSK_FAILED", "无法严格列出该实例的用户标签；请检查并更新 CLI、daemon 和扩展。不会新建或回退到 session/标签名称。");
  return parseTabs(reply.stdout);
}

export async function openAgentRouter(run: Runner, instanceId: string, tabId: number | undefined, remaining: () => number) {
  const candidates = siteCandidates(await listSiteTabs(run, instanceId, remaining));
  const selected = pickSiteTab(candidates, tabId);
  const args = selected
    ? ["tab", "select", String(selected.tab_id), "--browser-id", instanceId, "--expected-origin", selected.origin, "--json"]
    : ["tab", "create", siteUrl, "--browser-id", instanceId, "--json"];
  const options = { timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" } };
  try {
    const result = await run(args, options);
    remaining();
    if (result.exitCode !== 0) throw invalidOutput();
    const value = json(result.stdout);
    if (!object(value) || Object.keys(value).length !== 2 || !isTabId(value.tab_id) || !isTabId(value.window_id) ||
      (selected && value.tab_id !== selected.tab_id)) throw invalidOutput();
    return { action: selected ? "reused" as const : "created" as const, tabId: value.tab_id, windowId: value.window_id };
  } catch {
    throw new ZenxError("SITE_MUTATION_UNCERTAIN", "切换或创建请求未获得可确认的成功响应（可能被旧版组件拒绝、超时或响应异常），操作可能已生效；已停止，不重试、不新建替代标签。请人工核对，并检查 CLI、daemon 和扩展版本。");
  }
}

// 只读观察：不创建/切换/刷新标签，不启动 Edge，不读取表单值、存储或网络。
// 信号只是可见正文的启发式关键词命中，供人工或上层流程参考，不构成签到结论。
const CHECKED_IN_PATTERNS = ["已签到", "已打卡", "今日已签到", "签到成功", "打卡成功", "checked in", "already checked in"];
const CHECKIN_ACTION_PATTERNS = ["每日签到", "每日打卡", "立即签到", "今日签到", "check in", "check-in", "daily check"];

export type Observation = {
  origin: string;
  documentId: string;
  windowId: number;
  text: string;
  truncated: boolean;
  identity: "matched" | "absent";
  signals: { checkedIn: string[]; checkinAction: string[] };
};

function parseObservation(raw: string, instanceId: string, selected: Candidate): Omit<Observation, "identity" | "signals"> {
  const value = json(raw);
  if (!object(value) || Object.keys(value).length !== 7 ||
    value.browser_id !== instanceId || value.tab_id !== selected.tab_id || !isTabId(value.window_id) ||
    value.origin !== selected.origin || typeof value.document_id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value.document_id) ||
    typeof value.text !== "string" || [...value.text].length > 8000 || typeof value.truncated !== "boolean") throw invalidOutput();
  return { origin: value.origin, documentId: value.document_id, windowId: value.window_id, text: value.text, truncated: value.truncated };
}

function inspectFailure(raw: string): ZenxError {
  let detail = "";
  try {
    const value: unknown = JSON.parse(raw);
    if (object(value) && typeof value.message === "string") detail = value.message;
  } catch { /* 非 JSON 错误输出，忽略细节 */ }
  detail = detail.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  return new ZenxError("SITE_INSPECT_FAILED", `只读观察失败；未重试、未刷新页面。${detail ? `bsk：${detail}` : "请检查 CLI、daemon 和扩展版本。"}`);
}

export type InspectResult = {
  siteTab: { tabId: number; windowId: number; active: boolean } | null;
  observation?: Observation;
};

export async function inspectAgentRouter(run: Runner, instanceId: string, expectedIdentity: string, tabId: number | undefined, remaining: () => number): Promise<InspectResult> {
  const candidates = siteCandidates(await listSiteTabs(run, instanceId, remaining));
  const selected = pickSiteTab(candidates, tabId);
  if (!selected) return { siteTab: null };
  const reply = await run(["tab", "observe", "--browser-id", instanceId, "--tab-id", String(selected.tab_id), "--expected-origin", selected.origin, "--json"], {
    timeoutMs: Math.min(60_000, remaining()), env: { BSK_BROWSER_WAIT_MS: "0" },
  });
  remaining();
  if (reply.exitCode !== 0) throw inspectFailure(reply.stdout);
  const observed = parseObservation(reply.stdout, instanceId, selected);
  const lower = observed.text.toLowerCase();
  const observation: Observation = {
    ...observed,
    identity: observed.text.includes(expectedIdentity) ? "matched" : "absent",
    signals: {
      checkedIn: CHECKED_IN_PATTERNS.filter((pattern) => lower.includes(pattern.toLowerCase())),
      checkinAction: CHECKIN_ACTION_PATTERNS.filter((pattern) => lower.includes(pattern.toLowerCase())),
    },
  };
  return { siteTab: { tabId: selected.tab_id, windowId: selected.window_id, active: selected.active }, observation };
}
