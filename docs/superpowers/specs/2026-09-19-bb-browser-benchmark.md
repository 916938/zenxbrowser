# bb-browser 调研与借鉴方案

日期：2026-09-19

调研对象：[bb-browser](../../../bb-browser)（`d:\916938\bb-browser`）
影响范围：browserskill-new / browserskill-pro / zenxbrowser

## 目标

读透 bb-browser 的实现，提炼对我们三个项目有实际价值的设计点，排出落地顺序，避免"看着很好但和我们立场冲突"的照搬。

## 结论摘要

| 借鉴点 | 主要受益方 | 价值 | 成本 |
|---|---|---|---|
| 1. 统一命令注册表（单一定义源 → 多消费方） | browserskill-pro | 高（根治文档漂移） | 中 |
| 2. `seq` 单调递增 + RingBuffer + `since: last_action` | browserskill-new | 中 | 低 |
| 3. 错误按上下文合成 `hint` | 三个项目 | 中 | 低 |
| 4. Site adapter（`@meta` + 按域找 tab + evaluate） | zenxbrowser | 高（解耦站点逻辑） | 中 |
| 5. 观察/操作分层读取 | 已一致 | — | — |
| 6. 反自动化：裸 CDP，别加 stealth | zenxbrowser | 中（避坑） | 无 |
| 7. 设计不变量写成显式清单 | browserskill-new | 中 | 低 |
| 8. Tab 短 ID 由 targetId 后缀生成 | browserskill-new | 低 | 低 |

**明确不照搬**：Hub 远程模式 / WebRTC 视频流、MCP server、`network route` 拦截与 mock。详见文末。

---

## 1. 统一命令注册表

bb-browser 的 `packages/shared/src/commands.ts` 是**唯一定义源**，CLI 解析、daemon dispatch、Hub 注册全部从它读取：

```ts
export interface CommandDef {
  method: string;                 // 协议方法名
  group: "navigate" | "observe" | ...;
  description: string;
  requiresTab: boolean;
  params: Record<string, ParamDef>; // {type, required, position, description, default}
  // result schema is NOT needed here — it's daemon's concern
}
```

每个 `ParamDef` 自带 `position`（第几个位置参数）与 `default`，所以 CLI 参数解析、必填校验、文档说明三件事共用一份数据。

**我们的痛点正好对应**：browserskill-pro 的 `skill/SKILL.md`（Quick action map + Additional capabilities）、`skill/references/protocol.md`（Actions 表）、两份 README 的特性表，是**四处手工维护**的同一份事实。2026-09-18 刚因为漂移做过一次大同步（补 1.1.0 CHANGELOG、重写双语 README、补 `browsers close` 文档到 4 个文件）——这类漂移会反复发生。

bsk 侧已有 `dump-schema` 生成协议 JSON Schema，缺的是**面向 Agent 的那层元数据**。

### 落地要点（第 1 项，见下节"执行计划"）

- 数据源与文档分离：SKILL.md 里的人类说明（注意事项、决策树）必须保留手写，因此采用**标记区域生成**，只在 `<!-- BEGIN/END GENERATED -->` 之间覆盖。
- 生成器 + 校验器同一个脚本的两种模式（`--check`），校验失败非零退出，可接入 CI 与现有 `python -m unittest`。

---

## 2. `seq` 全局单调 + per-tab RingBuffer + 相对游标

`packages/daemon/src/tab-state.ts`：

- 每个 tab 独立 RingBuffer：network 500 / console 200 / jsErrors 100（定容，满则丢最旧，内存恒定）
- **全局** `seq` 单调递增，所有事件与操作共用，`since` 增量查询基于它
- 支持 `since: "last_action"` —— 相对"上次操作"而不是绝对数字

第三条尤其省事：Agent 不用自己记游标，直接表达"给我这次点击之后产生的请求"。bsk 现在是 `since → next_since` 绝对游标，语义相近但少了这层便利。

`RingBuffer` 本身是五十行的标准件，可直接抄思路（不抄代码，协议不同）。

---

## 3. 错误带上下文合成的 `hint`

bb-browser 的错误形状：`{"error": {"message": "...", "hint": "Run 'bb-browser tab list'"}}`。

更有价值的是它在 CLI 层**按上下文合成** hint：

- 按域名命中 site adapter → 追加"可用 `site <name>`"
- 判定为鉴权错误 → 追加登录提示
- 追加可直接复制的 issue 上报命令

bsk 已有 `error:` + `hint:` 输出，但基本是静态文案。可借鉴"按上下文合成"：例如 zenx 的 `ACCOUNT_ANCHOR_MISSING` 应提示"该 Profile 未登录 Edge，先人工登录一次"，`PROFILE_AMBIGUOUS` 提示"同一 Profile 开了多个 Edge，先关多余"。

---

## 4. Site adapter 三要素（对 zenx 最直接）

bb-browser 把"网站能力 CLI 化"：

1. 适配器是单个 JS 文件，头部 `/* @meta { name, description, domain, args, capabilities, readOnly, example } */`
2. daemon 扫描 `~/.bb-browser/sites`（local）与 `~/.bb-browser/bb-sites`（community），local 覆盖 community
3. 执行时按 `domain` 在已有 tab 中找匹配（含子域），找不到就新建；剥掉 `@meta` 后拼 IIFE 交给 CDP `evaluate`；同级 `_helper.js` 自动前置

**zenx 的现状**：agentrouter 的余额解析（`当前余额/Current balance`、`历史消耗/Consumption`）、签到流程、身份识别全部硬编码在 `src/console.ts` / `src/checkin.ts` / `src/site.ts`。

**抽成适配器后的收益**：

- 支持第二个站点时不动核心
- 站点改版只改一个文件
- `@meta` 里的 `readOnly` 可驱动"只读命令不得签到"这类约束（zenx 现有 checkin/snapshot/recheck 的只读边界是约定式的，没有机器可校验的声明）

---

## 5. 观察 vs 操作分层（已一致，仅确认）

bb-browser：长文本提取用 `eval`（省 token），元素操作用 `snapshot -i`（只要可交互元素）。
我们：bsk 的 `observe`（语义）→ `snapshot`（严格 a11y 树）→ `get-html` → `screenshot` 递进。

方向一致，说明 Pro 文档里的 escalate 链是对的，无需改动。

---

## 6. 反自动化：用裸 CDP，别加 stealth（避坑）

bb-browser 的结论写得很明确：

> Stealth 注入 = 有害。Google 的反自动化不检测 CDP 本身，而是检测 `Emulation.setUserAgentOverride`、`Page.addScriptToEvaluateOnNewDocument` 等 CDP domain 调用。不注入任何 stealth，用裸 CDP 即可。

对 zenx 的意义：**不要为了"更像真人"去加 UA/视口覆盖**。zenx 走真实 Profile + 真实窗口本来就是最稳的形态；bsk 的 `emulate`（UA/视口/触摸覆盖）在反检测严格的站点上反而更可疑。

（附带：Docker 场景要用有头 Chrome + Xvfb，因为 Linux 上 `--headless=new` 跳过 X11/Ozone 层，导致 WebGL、`navigator.plugins` 等返回异常值。我们目前无 Docker 需求，仅记录。）

---

## 7. 设计不变量写成显式清单

bb-browser 的 AGENTS.md 有一节"设计不变量"，8 条硬约束，例如：

1. Daemon 是唯一操作 API（CLI 和 Hub 都通过它）
2. Streamer 不做业务逻辑（不管 tab、不导航）
3. Tab ID 统一用 daemon 分配的短 ID
4. Site 执行在 daemon 内，不 shell-out CLI
5. 所有操作响应包含 `tab`
6. Per-tab 事件隔离，tab 关闭即释放
7. `seq` 全局单调递增，不可回退
8. Daemon 启动时清理旧进程

browserskill-pro 的 AGENTS.md 记的是"quirks"（坑），browserskill-new 的 AGENTS.md 记的是"命令 + quirks"。**"不变量"是另一种更强的写法**——它防止后续改动悄悄破坏架构。建议给 browserskill-new 补一节。

---

## 8. Tab 短 ID 生成

取 targetId 后缀，从 4 位开始递增直到不冲突：

```ts
for (let len = 4; len <= targetId.length; len++) {
  const candidate = targetId.slice(-len).toLowerCase();
  if (!this.shortToTarget.has(candidate)) return candidate;
}
```

简单、可读、无状态。bsk 的 `instance_id` 是扩展自生成的随机短 ID（稳定持久，语义不同），session id 是 4 位字母——两者目的不同，不必改，仅作备选思路记录。

---

## 明确不照搬

| 特性 | 不照搬的理由 |
|---|---|
| Hub 远程模式 / WebRTC 视频流 | 与"本地隐私优先"立场冲突；zenx 是本机多账号，无需远程 |
| MCP server | bsk 走 CLI + Agent Skill 已够，多一层协议反而增加维护面 |
| `network route` 拦截与 mock | 越过"只读取证"边界，且易被滥用；我们的红线是"不绕过站点安全机制" |

---

## 执行计划

按价值/成本排序，逐项推进。每项独立提交、独立可回滚。

| 序号 | 项目 | 仓库 | 交付物 | 验收 |
|---|---|---|---|---|
| **1** | Pro 命令清单可生成/可校验 | browserskill-pro | registry + 生成器 + `--check` + 测试 | `unittest` 全绿；故意改文档能报错 |
| 2 | zenx 站点适配器 | zenxbrowser | `src/sites/` + `@meta` + 加载器 | 现有 379 测试全绿，行为不变 |
| 3 | 上下文合成的 hint | 三个项目 | 错误码 → hint 映射 | 关键错误码覆盖 |
| 4 | `since: last_action` 相对游标 | browserskill-new | 协议 + CLI + 测试 | cargo test / vitest 全绿 |
| 5 | 设计不变量清单 | browserskill-new | AGENTS.md 新增一节 | 评审通过 |

### 第 1 项的完整输出要求

见 [2026-09-19-pro-command-registry.md](./2026-09-19-pro-command-registry.md)。
