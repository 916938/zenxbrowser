import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * zenx 拉起但尚未确认关闭的实例追踪（.zenx/leftover-instances.json）。
 *
 * 为什么需要它："本轮拉起"（launched）本来只活在单次进程内存里——上一轮没关掉的
 * 实例，在下一轮运行时会被当成"用户自己的 Edge"而永远保留，浏览器越开越多。
 * 把拉起事实落盘后，`zenx accounts close-leftover`（或 checkin-all --close-leftover）
 * 才能在事后识别并兜底关闭这些遗留实例。
 *
 * 语义：记录 = "这个实例是 zenx 拉起的，且从未确认关闭"。确认关闭、确认离线、
 * 或实例 ID 已改绑给其他账号时移除记录。写盘全部 best-effort：追踪失败绝不打断签到。
 */

const STATE_VERSION = 1;

export type LeftoverInstance = {
  alias: string;
  instanceId: string;
  launchedAt: string;
  /** 上一次兜底关闭失败的原因，便于事后排查。 */
  lastCloseError?: string;
};

export type LeftoverState = {
  version: typeof STATE_VERSION;
  updatedAt: string;
  instances: LeftoverInstance[];
};

export function leftoverFileFor(home: string): string {
  return join(home, "leftover-instances.json");
}

export async function readLeftovers(home: string): Promise<LeftoverState> {
  const file = leftoverFileFor(home);
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch { return { version: STATE_VERSION, updatedAt: "", instances: [] }; }
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Partial<LeftoverState>;
    if (record.version !== STATE_VERSION || !Array.isArray(record.instances)) throw new Error();
    const instances = record.instances.filter((item): item is LeftoverInstance =>
      item !== null && typeof item === "object" &&
      typeof (item as LeftoverInstance).alias === "string" &&
      typeof (item as LeftoverInstance).instanceId === "string" &&
      typeof (item as LeftoverInstance).launchedAt === "string");
    return { version: STATE_VERSION, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "", instances };
  } catch {
    // 追踪文件损坏不该让签到跑不起来：当作没有遗留。
    return { version: STATE_VERSION, updatedAt: "", instances: [] };
  }
}

async function writeLeftovers(home: string, state: LeftoverState): Promise<void> {
  const file = leftoverFileFor(home);
  const payload = { ...state, updatedAt: new Date().toISOString() };
  const temp = join(dirname(file), `.leftover-instances-${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

/** 记录"zenx 拉起了这个实例"。同一别名重复拉起时覆盖旧记录（旧实例 ID 已被新实例取代）。 */
export async function recordLaunchedInstance(home: string, alias: string, instanceId: string): Promise<void> {
  try {
    const state = await readLeftovers(home);
    const existing = state.instances.find((item) => item.alias === alias);
    if (existing) {
      existing.instanceId = instanceId;
      existing.launchedAt = new Date().toISOString();
      delete existing.lastCloseError;
    } else {
      state.instances.push({ alias, instanceId, launchedAt: new Date().toISOString() });
    }
    await writeLeftovers(home, state);
  } catch {
    // 追踪失败不影响签到。
  }
}

/**
 * 移除记录：实例已确认关闭或确认离线。给 instanceId 时只移除匹配的那条
 * （别名后来可能又被拉起成新实例，不能误删新记录）；不给则移除该别名的全部记录。
 */
export async function clearLaunchedInstance(home: string, alias: string, instanceId?: string): Promise<void> {
  try {
    const state = await readLeftovers(home);
    const kept = state.instances.filter((item) => !(item.alias === alias && (instanceId === undefined || item.instanceId === instanceId)));
    if (kept.length !== state.instances.length) await writeLeftovers(home, { ...state, instances: kept });
  } catch {
    // 追踪失败不影响关闭结果。
  }
}

/** 兜底关闭失败时把原因写回记录，下次 close-leftover 还会再试。 */
export async function markLeftoverCloseError(home: string, alias: string, instanceId: string, message: string): Promise<void> {
  try {
    const state = await readLeftovers(home);
    const entry = state.instances.find((item) => item.alias === alias && item.instanceId === instanceId);
    if (!entry) return;
    entry.lastCloseError = message.slice(0, 300);
    await writeLeftovers(home, state);
  } catch {
    // 追踪失败不影响关闭结果。
  }
}
