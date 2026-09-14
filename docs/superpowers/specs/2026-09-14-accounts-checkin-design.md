# accounts checkin 命令设计

日期：2026-09-14
状态：已获用户批准

## 背景与目标

ZenX 目前通过手动 bsk 命令序列完成 AgentRouter 签到（实测：edge-1/2/3 三账号退出重登后签到到账，edge-3 余额 $555.18 → $580.18）。本设计将实测流程固化为 `zenx accounts checkin <别名>` 命令，实现单命令完成"退出 AgentRouter → GitHub OAuth 重新登录 → 签到确认"全流程。

实测发现的两个关键事实：

1. **AgentRouter 签到机制**：退出后重新登录才会发放每日 $25 额度（站点 FAQ 明示"需要退出后重新登陆才会到账"）。
2. **公告弹窗动画时序**：页面加载自动弹出的系统公告（Semi Design 模态，`transform: scale(0.7)` 入场动画）在动画完成前点击坐标不可靠；等待 1.5s 后点击一次成功。

## 方案选择（已定）

方案 B：ZenX 内封装 bsk session 生命周期。新增 `src/checkin.ts` 编排模块，内部管理 `session start/stop` 与全部页面操作，复用 bsk 成熟的 observe/click 机制。ZenX 首次引入 session 概念（原有"不生成 session"红线修订为"仅 checkin 命令使用隔离 session，其余命令保持只读"）。

已否决：
- 方案 A（扩展 browser.tabs.click 协议）：破坏只读通道设计，改动面大。
- 方案 C（脚本编排）：无身份校验、无错误恢复、无法测试。

## 模块结构

```
src/checkin.ts        新增——签到编排
test/checkin.test.ts  新增——表驱动 mock 测试
src/cli.ts            修改——注册命令、更新 help
src/site.ts           不改动（inspect-site 保持只读）
```

`checkinAccount(home, run, alias, timeoutMs, deps)` 为唯一导出，签名与 `inspectSite` 对齐（`deps` 注入 `now/sleep` 便于测试控时）。

## Session 生命周期

- 启动：`session start --browser-id <id> --no-focus --json`，严格解析响应（顶层对象、恰好含 `session_id` 等已知字段、`session_id` 为 4 字符）。
- 使用：后续命令全部带 `--session <id>`；每次调用 `timeoutMs: Math.min(60_000, remaining())` 且 `env: { BSK_BROWSER_WAIT_MS: "0" }`。
- 结束：`finally` 中必定执行 `session stop <id>`；stop 自身失败不掩盖原始错误（仅 stderr 记录）。
- 锁：全程持 `withStoreLock`（与 open/ensure/configure/bind 互斥），预算用 `deadlineBudget(..., site=true)`。

## 签到状态机

| 步骤 | 操作 | 成功判据 | 失败处理 |
|---|---|---|---|
| ① 前置检查 | `listBrowsers`（复用 core.ts） | 在线 + Edge + 协议 1.0/1.1/1.3 | 返回 `{ok:false, connection:...}`，不启动 |
| ② 打开站点 | `navigate https://agentrouter.org` + wait 2s | observe 正文含 "Agent Router" | `SITE_TIMEOUT` |
| ③ 公告处理 | observe 含"系统公告"弹窗 → wait 1.5s → click "关闭公告" | 再 observe 无弹窗 | 重试一次（共两次点击）；仍失败报 `ANNOUNCEMENT_CLOSE_FAILED` |
| ④ 身份验证 | observe 正文含 `expectedIdentity` | matched | `IDENTITY_MISMATCH`，立即停止不重试 |
| ⑤ 记录余额 | observe 提取 `当前余额 $X` | 数值 | 无余额文本不算错（可能在登录页），跳过 |
| ⑥ 退出 | hover 用户菜单（`G <identity> chevron` 按钮）→ click "退出" | observe 出现"注销成功"或登录页特征 | `LOGOUT_FAILED` |
| ⑦ 重登 | click "使用 GitHub 继续" → 每 2s 轮询 observe，上限 60s | 正文含 `expectedIdentity` 与控制台特征 | 检测到 GitHub 授权/验证页特征 → `MANUAL_INTERVENTION_REQUIRED`（附页面特征文本）；超时 → `LOGIN_TIMEOUT` |
| ⑧ 签到确认 | observe 提取余额与"签到成功"信号 | 余额 > 旧值 或 含"签到成功"提示 | `CHECKIN_UNCONFIRMED`（成功状态未知，不重试） |

observe 响应解析复用 `site.ts` 的严格校验思路（已知字段、正文长度上限），但走 `--session` 通道而非 `tab observe`，新增独立的 `parseSessionObserve`（顶层为 bsk observe 的文本输出，非 JSON——observe 人读模式正文）。

注：`bsk observe`（session 模式）输出为带 `@eN` ref 的可读树。定位按钮需从 observe 输出中解析 ref：按行匹配 `@eN button "关闭公告"` 的模式提取 `@eN`，再传给 `click`/`hover`。ref 解析失败视为该步骤失败。

## 错误码（全部新增于 ZenxError 体系）

| 代码 | 含义 |
|---|---|
| `SESSION_START_FAILED` | session start 非零退出或响应畸形 |
| `ANNOUNCEMENT_CLOSE_FAILED` | 两次点击后公告仍在 |
| `LOGOUT_FAILED` | 退出后未见登录页 |
| `MANUAL_INTERVENTION_REQUIRED` | 检测到 GitHub 授权/验证/验证码页 |
| `LOGIN_TIMEOUT` | 重登轮询超 60s |
| `CHECKIN_UNCONFIRMED` | 流程完成但余额未变且无签到成功提示 |

原则：mutation 后页面不符合预期即报错停止，绝不重试（与 `openAgentRouter` 的 `SITE_MUTATION_UNCERTAIN` 范式一致）；唯一例外是步骤③公告关闭允许共两次点击（动画时序兜底）。

## CLI 接口

```
zenx accounts checkin <别名> [--timeout 3m]
```

- 默认总预算 3m（覆盖轮询 60s 上限 + 各步骤等待）。
- 成功报告：

```json
{
  "ok": true,
  "alias": "edge-1",
  "instanceId": "a82b44ca",
  "identity": "github_236536",
  "balanceBefore": 1375.00,
  "balanceAfter": 1400.00,
  "checkinCredited": true
}
```

- `balanceBefore`/`balanceAfter` 无法提取时为 `null`（不算失败）；`checkinCredited = 余额增加 || 出现"签到成功"提示`。
- 失败报告沿用 `{ok:false, error:{code, message, details}}`。

## 政策文案修订

- cli.ts help："不执行签到" → "`checkin` 执行完整退出重登签到流程；其余命令保持只读"。
- site.test.ts 中 `/不执行签到/` 断言改为匹配新文案（inspect-site 输出本身不变，仅检查范围调整）。

## 测试策略

`test/checkin.test.ts`，mock Runner 按 `args[0]`/`args[1]` 分支，脚本化响应序列：

- 快乐路径：公告→关闭→身份 matched→余额 $534.66→退出→GitHub 点击→轮询 3 次后身份 matched→余额 $559.66→`checkinCredited:true`。
- 公告两次点击仍失败 → `ANNOUNCEMENT_CLOSE_FAILED`。
- 身份不匹配（步骤④）→ `IDENTITY_MISMATCH`，断言无后续 click。
- 轮询中出现 GitHub 授权页特征 → `MANUAL_INTERVENTION_REQUIRED`。
- 轮询耗尽 → `LOGIN_TIMEOUT`。
- 余额未变且无提示 → `CHECKIN_UNCONFIRMED`（ok:false 但流程完整）。
- 所有失败路径断言 `session stop` 仍被调用（calls 数组尾部）。
- CLI 级：参数校验（缺别名、非法 timeout）、`--json` 输出结构。

## 非目标

- 不处理多个账号的批量签到（用户可脚本循环调用）。
- 不自动调 `bsk request-help`（遇验证页报错由人工处理，后续可加）。
- 不支持非 AgentRouter 站点。
