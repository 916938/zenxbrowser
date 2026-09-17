# ZenX 操作指南（日常运维手册）

面向**每天实际操作**的手册。命令的完整参数说明在仓库 [README](../README.md)，设计文档在 `docs/superpowers/specs/`。本文回答三件事：每天怎么跑、数字怎么看、出问题怎么办。

---

## 0. 环境自检

```powershell
node src/cli.ts doctor
```

必须全绿的四项：`bsk_cli`（bsk 可执行）、`bsk.daemon running`、`bsk.extension connected`、`bsk.browser protocol compatible`。

- 扩展报告协议版本不一致（`version skew`）只是警告，仍可使用，但应尽快升级扩展。
- **第一次跑 `accounts check` 报 `BSK_TIMEOUT` 是正常现象**（daemon 冷启动 + 实例多），重跑一次即可，不要当成故障去修。

---

## 1. 每日例行

### 推荐：一条命令跑完全部账号

```powershell
powershell -ExecutionPolicy Bypass -File scripts\daily-checkin.ps1
```

它会依次完成：`ensure-online`（离线才拉起 Edge）→ 每个账号 `checkin` → 每满 10 次登录冷却 11 分钟 → `snapshot --all` 采集当日余额与消耗 → 清理残留 session。

| 退出码 | 含义 |
|---|---|
| `0` | 全部成功 |
| `1` | 本次有新失败，需要关注 |
| `2` | 只是跳过了当天早前已失败的账号，本次没有新失败 |

- 日志：`\zenx\logs\checkin-YYYYMMDD.log`（按天追加）
- 失败名单：`.zenx\logs\failed-YYYYMMDD.txt`
- **失败的账号当天不再自动重试**：签到失败可能让账号停留在"已登出"状态，盲目重跑会反复 `IDENTITY_MISMATCH`、越跑越糟。人工完成一次 GitHub 登录后，用 `daily-checkin.ps1 -Force` 清掉名单再跑。
- 离线（`offline`）不计入失败名单 —— 签到根本没执行，账号状态没被碰过，重试是安全的。

### 注册为计划任务（每日 09:05，错过自动补跑）

```powershell
$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"D:\916938\zenxbrowser\scripts\daily-checkin.ps1`""
$trigger  = New-ScheduledTaskTrigger -Daily -At 09:05
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ZenX 每日签到" -Action $action -Trigger $trigger -Settings $settings
```

任务以**当前登录用户**运行（默认"只在用户登录时运行"，锁屏不影响）。不要选"不管用户是否登录都要运行" —— 那会跑在非交互会话，与已在该用户会话中的 Edge Profile 冲突。

---

## 2. 单个账号怎么操作

```powershell
node src/cli.ts accounts ensure-online edge-1     # 离线时拉起对应 Edge Profile
node src/cli.ts accounts checkin edge-1           # 签到（退出 → 重登 → 确认到账）
node src/cli.ts accounts recheck edge-1           # 只读复查：今天到底到账没有
node src/cli.ts accounts snapshot edge-1          # 采集该账号的余额/消耗快照
node src/cli.ts accounts snapshot --all           # 采集全部账号
node src/cli.ts accounts close edge-1 --confirm   # 关闭该实例的所有 Edge 窗口
```

几点约定：

- **`recheck` 是"签到后核对"工具，不是第二次签到**：不退出、不重登、不消耗站点登录配额，可以反复跑。退出码 `0` = 已确认到账，`1` = 未到账或异常。
- **`close` 会关掉该实例的所有窗口**（包括与本项目无关的窗口），未保存内容会丢；只用账号里绑定的精确实例 ID，失败不重试。
- 签到成功后想立即收尾，就 `close` —— 与 `ensure-online` 成对。

---

## 3. 看成果

### 网页报表（推荐）

```powershell
node src/cli.ts report            # http://127.0.0.1:8787/
node src/cli.ts report --open     # 自动打开浏览器
```

四块内容：**账号汇总**、**每日总额**（余额合计 / 当日消耗 / 当日签到到账 / 覆盖账号数）、**周月对比**（本期 vs 上期的到账与消耗）、**余额趋势**与打卡明细。

### 命令行查账本

账本在 `zenxbrowser/checkin.db`（SQLite）。例如查最近打卡明细：

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('zenxbrowser/checkin.db');for(const r of db.prepare('SELECT time,alias,balance_before,balance_after,credited,error_code FROM checkins ORDER BY id DESC LIMIT 20').all())console.log(r.time.slice(0,16),r.alias,r.balance_before,'->',r.balance_after,r.credited?'credited':'--',r.error_code||'')"
```

---

## 4. 数字是怎么算的（口径）

| 指标 | 口径 |
|---|---|
| **到账** | 签到带来的**余额实际增长**（`balance_after > balance_before`）。"签到成功"只是页面提示，重复登录也会出现，不作为到账依据。 |
| **消耗** | 站点「历史消耗」累计值的**区间增量**。**不用余额差** —— 余额同时被发放和消耗影响，用余额差会把"没签到"误算成"花多了"。 |
| **余额总额** | 当天各账号**最后一次**快照的余额之和，只统计当天真正有观测点的账号，并同时给出覆盖账号数。 |
| **跳过不入账** | 当天已到账/站点显示已签到而跳过的，不算一次签到，不进账本（否则虚增成功率）。 |

两个容易踩的坑：

- **错误码不等于没到账**。例：`edge-4` 报 `MANUAL_INTERVENTION_REQUIRED`，但复查发现余额已 501.1 → 526.1（+25），实际已到账。判断"到没到账"一律用 `recheck`，别用错误码。
- **消耗需要相邻两个观测点**。建立基线的第一天，消耗显示 `—` 是正常的，第二天才有真实曲线。区间内没有快照时同样是 `—`，不臆造数字。

---

## 5. 排障手册

### 5.1 窗口隐藏（最常见，且症状具有误导性）

Edge 窗口在后台/被完全遮挡/最小化时，页面不渲染余额，CDP 派发的输入也会被静默丢弃。表现为：

- `checkin` 报 `LOGOUT_FAILED`，但**退出其实已生效**（页面只是没跳转）
- `snapshot` 读到的 `balance` 是 `null`，有时甚至是 `0`
- 点击"使用 GitHub 继续"后页面不动（`window.open` 在隐藏窗口返回 `null`）→ `LOGIN_TIMEOUT`

**处理：先激活该 Profile 的 Edge 窗口再操作。**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\edge-window.ps1 -Marker "916938 13"
```

`Marker` 是窗口标题里的 **Profile 显示名**，不是目录序号（本机会有多个 Profile 被改名，例如 Default 显示名是 `3`、Profile 3 是 `916938 13`）。权威映射在 `User Data\Local State` 的 `profile.info_cache`。常用映射已写在脚本注释里。

窗口关不掉/要收尾时用同一个脚本：`-Action Close`（发 `WM_CLOSE`，优雅关闭，不会强杀进程）。

### 5.2 常见错误码

| 错误码 | 含义与处理 |
|---|---|
| `IDENTITY_MISMATCH` | 页面身份与绑定身份不符（通常是账号已登出），**未执行退出**。人工登录该账号后再签到。 |
| `LOGOUT_FAILED` | 多数是隐藏窗口导致，退出其实已生效 → 激活窗口重跑；真失败时账号仍在登录态，可直接重跑。 |
| `LOGIN_TIMEOUT` | 三种可能：隐藏窗口 `window.open` 被拦截（激活窗口）、GitHub 会话过期（人工登录）、站点限流（等约 10 分钟）。 |
| `MANUAL_INTERVENTION_REQUIRED` | 撞上 GitHub 授权/验证页，**只能人工**完成一次登录。 |
| `CHECKIN_UNCONFIRMED` | 流程跑完但余额没涨。用 `recheck` 核实；若当天早些时候登录过，额度可能已在那时发放。 |
| `CHECKIN_TIMEOUT` | 总预算（默认 3 分钟）耗尽，可用 `--timeout` 放宽到 5 分钟。 |
| `OFFLINE` / `WRONG_BROWSER` / `UNSUPPORTED_PROTOCOL` | 前置检查没过，**没有启动任何窗口**。先 `ensure-online`。 |

### 5.3 站点限流

连续登录约 10 次后站点会临时拒绝登录（点击有响应但不跳转，最终 `LOGIN_TIMEOUT`），约 10 分钟后恢复。批量脚本已内置"每 10 次登录冷却 11 分钟"。**不要短时间内手工反复退出重登同一批账号。**

### 5.4 工具本身的问题

| 症状 | 原因与处理 |
|---|---|
| `STORE_BUSY` | 账号锁 `.zenx\accounts.lock` 残留（进程被中断所致）。用 `node -e "require('fs').rmSync('.zenx/accounts.lock',{recursive:true,force:true})"` 清掉 —— **别用 PowerShell `Remove-Item`**，它会走环境的删除钩子、经常超时。 |
| `zenx accounts close` 报 `BSK_FAILED: browser.close not implemented` | 本机扩展版本不支持 `browser.close`。用 `scripts\edge-window.ps1 -Action Close` 兜底（关窗后 Edge 进程会后台驻留十几秒才退出，稍等即可，不用杀进程）。 |
| 账号一直 `offline`，`ensure-online` 也拉不回 | Edge 重启后扩展实例 ID 变了。用 `zenx accounts relink-profile <别名> --confirm`；**本机多数 Profile 被改名过，该命令基本匹配不上**，直接按 `Local State` 的显示名核对后改 `.zenx\accounts.json` 更可靠。 |
| `accounts.json` 损坏导致所有命令报 `INVALID_STORE` | `readStore` 要求 alias 与 instanceId 均唯一，重复就全挂。手工编辑后务必 `zenx accounts check` 验证。 |
| 关闭浏览器后某账号第二天签到 `IDENTITY_MISMATCH` | 该账号的站点会话没持久化（实测 `edge-p3` 会这样，其它账号不会）。收尾前确认它是登录态，或次日补一次登录。 |

---

## 6. 红线与安全

- **身份校验是红线**：控制台身份与绑定身份不符时立即停止，绝不执行退出 —— 防止在错误账号上操作。
- 只操作**已绑定的精确实例 ID**，不按标签/前缀匹配，不改选实例。
- 不保存密码、Cookie 或令牌；`close` 之外的命令保持只读（除 `checkin` 的退出重登外）。
- 账本 `zenxbrowser/checkin.db` 含账号身份与余额，**已被 `.gitignore` 排除**，不要提交。
- 隔离窗口必定回收：签到/复查/快照结束后都会 `session stop`；异常时日志里会报 `CLEANUP_INCOMPLETE`，需手动关掉那个 Edge 窗口。

---

## 7. 维护

- 备份：`zenxbrowser/checkin.db`（连同 `-wal`/`-shm` 一起复制）就是全部历史，复制文件即可。
- 账本自 2026-09-16 才启用，更早的签到没有落库。
- 改代码后跑 `npm test`（全量测试）与 `npm run check`（语法检查）。
