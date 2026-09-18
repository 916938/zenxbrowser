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
node src/cli.ts accounts login edge-1             # 只补登录：把停在登出态的账号拉回登录态
node src/cli.ts accounts recheck edge-1           # 只读复查：今天到底到账没有
node src/cli.ts accounts snapshot edge-1          # 采集该账号的余额/消耗快照
node src/cli.ts accounts snapshot --all           # 采集全部账号
node src/cli.ts accounts close edge-1 --confirm   # 关闭该实例的所有 Edge 窗口
```

### 批量签到（推荐替代 PowerShell 脚本）

```powershell
node src/cli.ts accounts checkin-all                       # 全部账号，命中限流自动冷却重试一次
node src/cli.ts accounts checkin-all --wait 12m --retries 1
node src/cli.ts accounts checkin-all --close-after         # 每个账号成功即关掉其 Edge，释放内存
node src/cli.ts accounts checkin-all --retry-codes LOGIN_RATE_LIMITED,LOGIN_TIMEOUT
```

三条行为准则：

- **命中限流立刻停手**：限流是站点侧的**共享配额**（同一出口 IP 连续登录若干次触发），此时任何账号都登录不上。本轮剩下的账号会被推迟到冷却后统一重试，而不是继续把更多账号退出成登出态。
- **每次尝试都记状态**：`.zenx\checkin-state.json` 记录每个账号的最后尝试时间、结果、错误码与重试次数，中断后可接着看。
- **默认重试一次**（`--retries`），冷却默认 15 分钟（`--wait`）。重试后仍失败就以失败收尾，不再无限循环。

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

四块内容：**账号汇总**（含每号余额的观测时间，非当天的会置灰）、**每日总额**（余额合计 / 当日消耗 / 当日签到到账 / 覆盖账号数）、**周月对比**（本期 vs 上期的到账与消耗）、**余额趋势**与打卡明细。

顶部"账号数"卡片显示 `有数据 / 已绑定` 两个数，并在两者不一致时列出尚未产生观测点的别名。看到差额不必惊慌：那是"还没跑过任何命令"，不是"账号丢了"。

### 命令行查账本

账本在 `zenxbrowser/checkin.db`（SQLite）。例如查最近打卡明细：

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('zenxbrowser/checkin.db');for(const r of db.prepare('SELECT time,alias,balance_before,balance_after,credited,error_code FROM checkins ORDER BY id DESC LIMIT 20').all())console.log(r.time.slice(0,16),r.alias,r.balance_before,'->',r.balance_after,r.credited?'credited':'--',r.error_code||'')"
```

---

## 4. 数字是怎么算的（口径）

| 指标 | 口径 |
|---|---|
| **账号数** | 报表同时给出"有数据的账号 / 已绑定的账号"。只有观测点（签到或快照）才会在账本里留痕，**刚绑定、还没跑过命令的账号不会凭空出现**，因此两个数字可能不同——差异会直接列在页面顶部。 |
| **到账** | 优先取签到记录里的**余额实际增长**（`balance_after > balance_before`）；同一账号同一天没有增长记录时，按快照反推：**到账 = Δ余额 + Δ消耗**。后者用于补算"额度靠 `zenx accounts login` 发放、签到记录却是失败"的账号。"签到成功"只是页面提示，重复登录也会出现，不作为到账依据。 |
| **消耗** | 站点「历史消耗」累计值的**区间增量**。**不用余额差** —— 余额同时被发放和消耗影响，用余额差会把"没签到"误算成"花多了"。 |
| **余额总额** | 每个账号**截至该日的最后一次已知余额**（向前填充），并同时给出覆盖账号数与"沿用更早观测点"的账号数。只在当天恰好被采集的账号上求和会让漏采的号凭空消失，总额随之失真。 |
| **余额为 0** | 窗口隐藏时站点会渲染出 `0`（实测）。统计一律**视为缺失**，绝不把它当真余额——否则会出现 0 → 1175 这种假到账。 |
| **跳过不入账** | 当天已到账/站点显示已签到而跳过的，不算一次签到，不进账本（否则虚增成功率）。 |

两个容易踩的坑：

- **错误码不等于没到账**。例：`edge-4` 报 `MANUAL_INTERVENTION_REQUIRED`，但复查发现余额已 501.1 → 526.1（+25），实际已到账。判断"到没到账"一律用 `recheck`，别用错误码。
- **`recheck` 会记账，不改站点状态**：确认到账但账本当天没有记录时，它会补一条到账记录（`--record no` 可关闭）。额度不一定由 `checkin` 发放，`login` 恢复登录态也会发放——钱领到了就不该在报表里显示为"没签到"。
- **消耗需要相邻两个观测点**。建立基线的第一天，消耗显示 `—` 是正常的，第二天才有真实曲线。区间内没有快照时同样是 `—`，不臆造数字。

---

## 5. 排障手册

### 5.0 实例 ID 漂移与 `relink-account`（推荐）

Edge 重启后扩展实例 ID 会变，账号里存的旧 ID 随之失效（表现为一直 `offline`）。`relink-account` 用**账号锚点**重新定位，而不是窗口标题里的显示名：

- 锚点 = 该 Profile 的 `Preferences → account_info.account_id`，浏览器给已登录账号分配的不透明 ID（本机实测 16 位十六进制），**不是邮箱、不是凭证**，跨 Edge 重启稳定、各 Profile 互不相同。
- `configure-launch` 会自动记录锚点；已配置的账号可用一次性补写脚本或直接跑一次本命令（读不到时会回退已记录的锚点）。
- 判定顺序：① `bsk browsers` 直报 `profile_account_id`（需 fork 构建 + 扩展开关，零探测不开窗口）→ ② 开临时隔离窗口，用标题标记确定 Profile 子目录，再读其 account_id 比对（必定回收探测窗口）。
- 结果里的 `method` 字段说明走了哪条路（`bsk` / `preferences`）。

```powershell
zenx accounts relink-account edge-p15 --confirm
# { "ok": true, "previousInstanceId": "deadbeef", "instanceId": "ddb6e152", "changed": true, "method": "preferences" }
```

| 错误码 | 含义与处理 |
|---|---|
| `ACCOUNT_ANCHOR_MISSING` | 该 Profile 的 Preferences 读不到 account_id，且配置里也没记录。通常意味着**这个 Profile 没登录 Edge**，先人工登录一次。 |
| `PROFILE_NOT_FOUND` | 没有在线实例属于该 Profile；先 `ensure-online` 启动对应 Profile 的 Edge。 |
| `PROFILE_AMBIGUOUS` | 多个在线实例都指向同一锚点（同一 Profile 开了多个 Edge 进程）。**不会改绑**，先关掉多余的 Edge。 |

> 注意 `account_info` 在不同 Profile 里形状不同（有的是对象、有的是数组），解析时两种都要兼容；数组里出现多个不同账号 ID 时按"无法确定"处理，不猜。

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
| `LOGIN_TIMEOUT` | 三种可能：隐藏窗口 `window.open` 被拦截（激活窗口）、GitHub 会话过期（人工登录）、**站点限流**（等待 10–15 分钟后用 `zenx accounts login` 恢复）。 |
| `LOGIN_RATE_LIMITED` | 站点明示“登录次数过多/请稍后再试”。**不要再接着跑**：所有账号都受影响，让 `checkin-all` 冷却重试，或等待 10–15 分钟后用 `login` + `recheck` 收尾。 |
| `MANUAL_INTERVENTION_REQUIRED` | 撞上 GitHub 授权/验证页，**只能人工**完成一次登录。 |
| `CHECKIN_UNCONFIRMED` | 流程跑完但余额没涨。用 `recheck` 核实；若当天早些时候登录过，额度可能已在那时发放。 |
| `CHECKIN_TIMEOUT` | 总预算（默认 3 分钟）耗尽，可用 `--timeout` 放宽到 5 分钟。 |
| `OFFLINE` / `WRONG_BROWSER` / `UNSUPPORTED_PROTOCOL` | 前置检查没过，**没有启动任何窗口**。先 `ensure-online`。 |

### 5.3 站点限流

连续登录约 10 次后站点会临时拒绝登录（点击有响应但不跳转，最终 `LOGIN_TIMEOUT`），约 10 分钟后恢复。批量脚本已内置"每 10 次登录冷却 11 分钟"。**不要短时间内手工反复退出重登同一批账号。**

### 5.4 账号停在登出态（checkin 已无法自救）

checkin 在重登阶段失败（限流、GitHub 会话过期、隐藏窗口）后，账号会留在**登出态**；而 checkin 的身份验证要求先处于正确登录态，于是它只会报 `IDENTITY_MISMATCH`，再也完不成签到。**此时不要继续跑 checkin**，改用只做登录的命令：

```powershell
node src/cli.ts accounts login edge-1     # 已登录则原样返回；在登录页则点 GitHub 登录并等落地
node src/cli.ts accounts recheck edge-1   # 用余额增量确认今天到账没有（+25 即已发放）
```

因为签到额度是"登录即发放"，登录恢复后 `recheck` 看到余额相对昨日基线涨了 25，就说明当日额度已到，无需再跑一次 checkin（再跑只会白白再退出一次）。

### 5.5 内存：签到完就释放

十几个 Edge Profile 同时常驻是本机最大的内存开销。两条约定：

- `checkin-all --close-after`：每个账号签到成功（或确认已到账）后立即 `accounts close`，把该实例的窗口与进程一并退出；批量跑到中途遇限流冷却时，已完成账号也会保持关闭状态，不会白占 15 分钟内存。
- 不想关时至少确认没有残留 session：`bsk session list` 应显示 `no active sessions`。

注意 `close` 依赖 fork 构建的 `browser.close`；本机扩展仍是 0.2.3 时会报 `unknown_method: browser.close not implemented`，此时兜底用 `scripts\edge-window.ps1 -Marker <显示名> -Action Close`（见 5.1）。

### 5.6 工具本身的问题

| 症状 | 原因与处理 |
|---|---|
| `STORE_BUSY` | 账号锁 `.zenx\accounts.lock` 残留（进程被中断所致）。用 `node -e "require('fs').rmSync('.zenx/accounts.lock',{recursive:true,force:true})"` 清掉 —— **别用 PowerShell `Remove-Item`**，它会走环境的删除钩子、经常超时。 |
| `zenx accounts close` 报 `BSK_FAILED: browser.close not implemented` | 本机扩展版本不支持 `browser.close`。用 `scripts\edge-window.ps1 -Action Close` 兜底（关窗后 Edge 进程会后台驻留十几秒才退出，稍等即可，不用杀进程）。 |
| 账号一直 `offline`，`ensure-online` 也拉不回 | Edge 重启后扩展实例 ID 变了。用 `zenx accounts relink-account <别名> --confirm`（按账号锚点定位，不受 Profile 改名影响；本机多个 Profile 被改名过，Default 显示为 `3`、Profile 3 显示为 `916938 13`）。 |
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
