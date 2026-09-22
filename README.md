# ZenX Browser

ZenX Browser 项目由以下三个子项目构成：

- `zenxbrowser-skills`
- `browserskill-new`
- `browserskill-pro`

项目地址：[browser.zenx.tech](https://browser.zenx.tech)

## zenx CLI

`zenx` 是本仓库自带的 Windows Edge 多账号连接台（入口 `src/cli.ts`，Node ≥ 22.18 可直接运行 TypeScript），通过 `bsk` CLI 与 Edge 扩展管理多个 Edge Profile 上的 AgentRouter 账号。

> **日常怎么跑、出问题怎么办、数字怎么算**，见 [`docs/operations.md`](docs/operations.md)（操作指南 / 排障手册）。本文件是命令与设计参考。

```powershell
node src/cli.ts --help    # 查看全部用法；也可 npm start -- --help
```

### 环境要求

- Windows + Microsoft Edge（每个账号使用独立 Profile）
- Node.js ≥ 22.18.0
- `bsk` 可执行文件（默认从 PATH 查找，可用环境变量 `ZENX_BSK_PATH` 指定绝对路径）
- Edge 扩展已连接（`zenx doctor` 可一键检查 bsk/daemon/扩展状态）

> ⚠️ **`bsk` 必须是 fork 构建**（[`916938/browserskill-new`](https://github.com/916938/browserskill-new) **0.4.0+**），
> **不是**上游 [`Tencent/BrowserSkill`](https://github.com/Tencent/BrowserSkill) 的发布版 —— 上游跑不起来。
> zenx 依赖的这些能力只在 fork 里有：`browsers close`（关掉整个 Edge 实例）、
> `tab list|create|select --browser-id` 与 `tab observe`（多 Profile 定位）、
> `browsers` 上报的 profile account id（账号锚点重绑依赖它）、instance smart labels。
> fork 使用独立版本线，号码始终高于最后一次同步的上游版本（上游 0.3.0 → fork 0.4.0），单看版本号即可分辨。
> 上游的 remote/server 模式 fork 虽携带但**不支持**，不要依赖。

### 让 `zenx` 命令能直接敲

`zenx` 不是安装出来的二进制——仓库里没有编译产物，它只是个启动器，实际跑的是 `src/cli.ts`。所以裸敲 `zenx` 报 “不是 cmdlet/可执行文件” 是**没装启动器**，不是命令不存在。两种跑法：

1. **不装，直接跑**（任何目录都行，记得先 `cd` 到仓库根）：

   ```powershell
   node src/cli.ts accounts checkin-all
   ```

2. **装成命令**（推荐）：仓库根目录的 [`zenx.cmd`](zenx.cmd) 就是启动器，它按 `ZENX_NODE` → PATH 里的 `node` → 常见安装目录（含 nvm）的顺序找 Node，找不到就报 `cannot find node.exe` 并以 127 退出。把仓库根加入 PATH，或在 PATH 里已有的目录放一个转发器：

   ```powershell
   # 目标目录必须在 PATH 中（这里用 %USERPROFILE%\.local\bin，按实际路径改仓库路径）
   Set-Content -Encoding ASCII "$env:USERPROFILE\.local\bin\zenx.cmd" `
     -Value '@echo off', 'call "D:\916938\zenxbrowser\zenx.cmd" %*', 'exit /b %ERRORLEVEL%'
   ```

   之后任意目录都能 `zenx accounts checkin-all`。

> 只复制 `zenx.cmd` 本身到别处不管用：它按自身所在目录定位 `src/cli.ts`，必须配上面的转发器（或把仓库根加进 PATH）。

### 常用命令

| 命令 | 说明 |
|---|---|
| `zenx doctor` | 检查 bsk、daemon 与扩展连接状态 |
| `zenx profiles list` | 列出已连接的扩展实例 |
| `zenx accounts bind <别名> --instance-id <ID> --expected-identity <站点身份> --confirm` | 绑定账号（首次使用） |
| `zenx accounts check` | 检查所有账号连接状态 |
| `zenx accounts configure-launch <别名> --edge-path <msedge.exe> --user-data-dir <用户数据根目录> --profile-directory <Profile子目录> --confirm` | 配置 Edge 启动参数 |
| `zenx accounts ensure-online <别名>` | 离线时启动对应 Edge Profile |
| `zenx accounts relink-account <别名> --confirm` | 实例 ID 变化后按账号锚点重新定位并改绑 |
| `zenx accounts close <别名> --confirm` | 关闭该账号绑定的 Edge 实例（与 `ensure-online` 成对） |
| `zenx accounts open-site <别名>` | 打开（或切换到）AgentRouter 标签页 |
| `zenx accounts inspect-site <别名>` | 只读核对登录身份与签到信号 |
| `zenx accounts checkin <别名>` | 执行完整退出重登签到流程（支持无人值守/计划任务）；`--close-after` 在签到成功后连浏览器实例一起释放 |
| `zenx accounts login <别名>` | 只补“登录”这一步：把重登失败后停在登出态的账号拉回登录态（不退出、不签到） |
| `zenx accounts checkin-all` | 批量签到：自动处理站点登录限流（冷却 `--wait` 后重试 `--retries` 次），`--window`（默认 8）限制同时在线账号数，`--close-after` 逐个释放实例内存；全程开启防休眠（`--inhibit-sleep no` 关闭，`--inhibit-timeout` 设上限） |
| `zenx accounts recheck <别名>` | 只读复查该账号今日签到额度是否已到账（不退出、不重登） |
| `zenx accounts snapshot <别名>` / `--all` | 采集余额与站点累计消耗，写入账本（周/月对比的观测点） |
| `zenx report [--port 8787] [--open]` | 启动本地网页报表，查看签到统计与余额趋势 |

账号数据保存在 `.zenx/accounts.json`；可用 `--home <目录>` 或环境变量 `ZENX_HOME` 指定数据目录。全局加 `--json` 输出 JSON。除 `checkin` 外其余命令均保持只读，不保存密码、Cookie 或令牌。

### 关闭浏览器：`zenx accounts close`

`ensure-online` 能按需拉起某个 Profile 的 Edge，收尾对应的是：

```powershell
zenx accounts close edge-1 --confirm
```

它调用 `bsk browsers close`，先停止该实例的全部会话，再关闭其所有窗口，浏览器进程随之退出。安全约束：

- 只用账号里**已绑定的精确实例 ID**，不按标签/前缀匹配；离线、非 Edge、协议不兼容都直接报错，绝不改选实例。
- 必须 `--confirm`：这会关掉该实例**所有**窗口（包括与本项目无关的窗口），未保存内容会丢失。
- 失败一律不重试、不杀进程——关闭可能已生效，只报告“无法确认”，请用 `zenx accounts check` 核对。
- 需要支持 `browser.close` 的 bsk 版本（本机 0.2.3 尚未包含，见 browserskill-new 的 `feat/browser-close` 分支）。

## 在 agentrouter.org 每日打卡得积分

AgentRouter 的每日签到机制比较特殊：**必须退出账号后重新登录**，当日积分（$25 额度）才会发放（站点 FAQ 明示“需要退出后重新登陆才会到账”）。`zenx accounts checkin` 把这套流程固化为一条命令：

```powershell
# 1.（可选）确保对应 Edge Profile 已在线；离线会自动启动一次
node src/cli.ts accounts ensure-online edge-1

# 2. 一条命令完成签到：核对身份 → 退出 → GitHub 重新登录 → 确认积分到账
node src/cli.ts accounts checkin edge-1
```

### 命令执行流程

1. 前置检查：浏览器在线、为 Edge、协议受支持，否则直接返回，不启动任何窗口
2. 创建隔离 session（显式 1280×800 尺寸），打开 <https://agentrouter.org/console> 仪表盘
3. 窗口输入可用性预检 → 通过 evaluate 收敛页面动画后，自动关闭系统公告弹窗
4. 核对页面登录身份与绑定身份（`--expected-identity`）一致；不一致立即停止，不执行退出。**例外**：页面是**登录页**（站点会话掉线）不算身份不符——GitHub 会话通常还在，zenx 会直接点「使用 GitHub 继续」登录；登录事件本身即发放当日额度，登录后确认到账即可，不再多走一次退出重登
5. 记录当前余额 → 悬停用户菜单退出账号 → 点击“使用 GitHub 继续”重新登录
6. 重新登录完成后回到控制台仪表盘读新余额确认到账（余额增加或出现“签到成功”提示），输出结果并自动回收 session

成功输出示例：

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

`balanceBefore`/`balanceAfter` 提取不到时为 `null`（不算失败）；`checkinCredited` 为余额增加或出现“签到成功”提示。

### 注意事项

- **支持无人值守**：可用于计划任务定时执行。锁屏、无交互桌面、窗口被遮挡都能正常签到——zenx 会先探测页面是否可见，并据此选择输入通道：
  - **页面可见** → 走 CDP 输入通道（`bsk click`/`hover`，真实鼠标事件）。
  - **页面隐藏** → 自动切换为 **DOM 直调**：在页面内按元素文本定位并调用 `element.click()` / 派发合成指针事件。原因是隐藏时 Windows 会把鼠标事件交给前台窗口，CDP 派发的输入被静默丢弃（`bsk` 仍报 `click ok`，但坐标与元素实际位置不符，页面毫无反应）。
  - 无论哪种通道，页面动画都由 evaluate 强制收敛；隐藏时还会补发 `animationend`/`transitionend`，否则公告弹窗不会卸载。
  - GitHub 登录按钮用 `window.open(授权地址)`，隐藏时会被浏览器返回 `null` 导致卡在登录页。此时 zenx 会临时接管 `window.open` 捕获该地址，再改用 `location.href` 同 tab 跳转。
  - 窗口尺寸（哪怕 `outerWidth` 为 0，后台 Edge 常见）不影响判定，只要页面能求值就继续；只有求值本身失败才报 `WINDOW_NOT_INTERACTIVE`。
- **遇验证页自动停止**：检测到 GitHub 授权页、两步验证、验证码等特征时报 `MANUAL_INTERVENTION_REQUIRED`，需人工完成登录后重新执行 `checkin`（这是无人值守唯一无法自动处理的情况：GitHub 会话过期需要人工重新登录一次）。
- **站点已登出不用人工登录**：页面停在站点登录页（站点会话掉线）时，checkin 会自己点「使用 GitHub 继续」登录——GitHub 会话通常还在，这一步不需要人。登录事件本身就发放当日额度，登录后能确认到账就不再退出重登，省一次登录配额；确认不了才继续走退出重登。旧版在这里一律报 `IDENTITY_MISMATCH` 并提示"请先人工登录"，那是误报。
- **登录频率限制（重要）**：站点对连续登录有限制——**连续登录约 10 次后会被临时拒绝登录**，需等待约 10 分钟才恢复。症状很隐蔽：点击 GitHub 按钮有响应但页面不跳转，最终报 `LOGIN_TIMEOUT`。因此不要短时间内反复手工退出重登同一批账号；批量脚本每完成 10 次签到会自动暂停 11 分钟（见下方脚本）。**当前脚本 20 个账号**：每满 10 次登录插入一次 11 分钟冷却（20 个账号仍只在第 10 次后冷却一次，属预期行为，不是故障）。冷却前后都会把时间写进当天日志。
- **总预算默认 3 分钟**：`--timeout` 可调（最大 5m），超时报 `CHECKIN_TIMEOUT`。
- **隔离窗口必定回收**：签到成功或失败后，隔离窗口都会被关闭（`session stop`），不留标签页在桌面上。关闭失败时会在输出中报 `CLEANUP_INCOMPLETE`（同时也会打印到 stderr），此时请手动关掉那个 Edge 窗口；批量脚本在全部账号跑完后还会兜底清理一次残留 session。
- **多账号**：不内置批量签到；在脚本中按别名循环调用即可，每个账号独立执行一次。
- **LinuxDO 站点账号也可用**：站点用户名可能显示为 `linuxdo_xxx`，只要该账号绑定了 GitHub，就仍走“退出 → 使用 GitHub 继续”重新登录，登录前后站点身份不变（已实测：`linuxdo_25672`、`linuxdo_27030` 账号经 GitHub 登录后仍显示原 linuxdo 身份，额度正常到账）。用户菜单的首字母是登录来源标识（G=GitHub、L=LinuxDO），zenx 不依赖它校验身份。
- **签到后核对**：可用 `zenx accounts inspect-site <别名>` 只读查看当前登录身份与余额。

### 复查：当日额度到底到账没有（`zenx accounts recheck`）

签到报失败或 `CHECKIN_UNCONFIRMED` 之后，用这条命令只读核对"今天到底到账没有"：

```powershell
node src/cli.ts accounts ensure-online edge-1    # 离线时先拉起（recheck 自身不启动 Edge）
node src/cli.ts accounts recheck edge-1 --json
```

```json
{ "ok": true, "alias": "edge-1", "identity": "github_236536", "login": "logged_in",
  "balance": 1450, "creditedToday": true, "baselineBalance": 1425, "balanceDelta": 25,
  "verdict": "credited", "note": "已确认今日到账（依据：账本今日已有到账记录）。" }
```

判定顺序：① 未登录 / 撞上 GitHub 授权页 → 不给额度结论，需人工登录；② 登录身份与绑定身份不符 → `identity_mismatch`；③ 账本今日已有到账记录、站点显示"今日已签到"、或余额相对基线增长 ≥ $25 → `credited`；④ 三者都没有 → `not_credited`。

要点：

- **不退出、不重新登录、不消耗站点登录配额**，可以反复跑；隔离窗口同样必定回收。
- **退出码**：`0` = 已确认到账，`1` = 未到账或异常，便于脚本里直接判断。
- **离线只报告、不启动 Edge**：先用 `ensure-online` 拉起。
- `baselineBalance` 取账本里"今天开始前"的最后一次余额。**新账号首次签到没有基准**（`null`），此时只剩账本和站点两个信号，结论会退化成 `not_credited` —— 那是"无法证明"，不等于"确认没发"。

### 排障：实例 ID 变化导致账号“离线”

Edge 重启后扩展的**实例 ID 会变**，而 `accounts.json` 里存的是固定 ID。一旦变化，账号就会一直报 `offline`（`ensure-online` 也拉不回来），看起来像“Edge 挂了”，其实是绑错了对象。

用 `relink-account` 按**账号锚点**重新定位：

```powershell
zenx accounts relink-account edge-8 --confirm
```

锚点就是该 Profile 的 `Preferences → account_info.account_id`：浏览器给已登录账号分配的不透明 ID（本机实测 16 位十六进制），**不是邮箱也不是凭证**，跨 Edge 重启稳定、各 Profile 互不相同——因此不受"Profile 显示名被改名"的影响（本机 Default 显示成 `3`、Profile 3 显示成 `916938 13`，按显示名匹配的老办法早已失效）。

```json
{ "ok": true, "alias": "edge-8", "profileDirectory": "Profile 8",
  "profileAccountId": "580c3c71de3c6b3b", "previousInstanceId": "6fae1ec3",
  "instanceId": "d9067149", "changed": true, "method": "preferences" }
```

两路判定，`method` 字段说明走了哪条：

- **`bsk`**：`bsk browsers` 直接上报 `profile_account_id`（需 fork 构建 + 扩展里打开「共享 Profile 账号 ID」）。零探测、不开任何窗口。
- **`preferences`**（当前本机走的这条）：给候选实例开临时探测窗口，用窗口标题（形如 `New tab - 8 - Microsoft Edge`）确定它属于哪个 Profile 子目录，再读该目录的 `account_id` 与锚点比对。

说明：

- **前提**是账号已用 `configure-launch` 配置过 Profile（锚点会随之自动记录），命令不会猜。
- 不启动也不关闭任何 Edge；临时探测窗口必定回收（失败也会尝试 `session stop`）。
- **锚点在候选里必须唯一**，多个实例同锚点时报 `PROFILE_AMBIGUOUS` 且**不改绑**——宁可不动，也不绑错账号。
- 没找到报 `PROFILE_NOT_FOUND`；未配置启动路径报 `LAUNCH_NOT_CONFIGURED`；读不到账号 ID 报 `ACCOUNT_ANCHOR_MISSING`（通常是该 Profile 没登录 Edge）。
- 批量修复所有账号：`zenx accounts check` 找出 offline 的，逐个跑上面的命令。
- 仅 Windows 可用（依赖窗口标题枚举与 Edge 用户数据目录）。

### 签到统计（SQLite + 网页报表）

每次 `checkin` 都会把结果写入 `zenxbrowser/checkin.db`（SQLite，Node 内置驱动，零 npm 依赖）：打卡时间、账号、身份、打卡前后余额、是否到账、失败错误码。成功与失败都记录，失败也要留痕。

查看报表：

```powershell
node src/cli.ts report              # 启动后访问 http://127.0.0.1:8787/
node src/cli.ts report --open       # 自动打开浏览器
node src/cli.ts report --port 9000  # 换端口
```

报表包含：账号汇总卡片、每账号当前余额/累计到账/成功率、余额趋势图（SVG）、全部打卡明细（失败行标红并显示错误码）。仅监听本机回环地址，`Ctrl+C` 停止。

统计口径：

- **累计到账**只统计余额实际增长的记录；当天重复签到（`credited` 但余额不变）计入成功次数，不计入金额。
- **当前余额**取该账号最近一条非 NULL 的打卡后余额。
- 余额提取不到时存 `NULL`（不会写成 0）。
- 数据库写入失败不会改变签到结果（账本不能反过来影响打卡）。

### 每日快照与周/月对比（到账 vs 消耗）

签到记录只反映"签到那一刻"的余额，而**每个账号都可能被单独使用** —— 两次签到之间花掉的钱，凭签到记录完全看不见。所以除了签到，还要**每天落一个观测点**：

```powershell
node src/cli.ts accounts snapshot --all --json     # 依次采集全部已绑定账号
node src/cli.ts accounts snapshot edge-1 --json    # 只采集一个
```

每次往 `balance_snapshots` 表写一条：时间、账号、身份、**当前余额**、**站点累计消耗**、是否成功、失败错误码。

- 只读：不退出、不重新登录、不消耗站点登录配额；隔离窗口同样必定回收。
- **失败也留一条**（`ok=false` + 错误码，如 `OFFLINE`、`LOGGED_OUT`、`IDENTITY_MISMATCH`），保证"今天试过"这件事在账本里有痕。
- `--all` 依次采集全部账号，单个失败不中断。

报表（`node src/cli.ts report`）新增两块：

- **每日总额**：每天的**余额总额**、**当日消耗总额**、当日签到到账，以及覆盖账号数；顶部卡片给出最新一日的余额总额与消耗。
- **周/月对比**：每个账号的本期到账、本期消耗、净额，连同上一期同口径数据，并给出合计行。

口径：

- **到账** = 区间内签到带来的余额实际增长之和（与"累计到账"一致）。
- **消耗** = 站点「历史消耗」累计值的**区间增量**。**不用余额差**：余额同时被"发放"和"消耗"影响，用余额差会把"没签到"误算成"花多了"；累计消耗只增不减，差分才是真实花费。
- 区间内没有任何快照时，消耗显示 `—`，不臆造数字。
- 总额只统计**当天真正有观测点**的账号，并同时给出覆盖账号数 —— 不会把"今天只采了 3 个号"当成全员总额。消耗还需要相邻两个观测点，所以首次采集那天显示 `—`。
- 每个账号一天若采集多次，以**最后一次**为准。

`--all` 已接进 [`scripts\daily-checkin.ps1`](file:///d:/916938/zenxbrowser/scripts/daily-checkin.ps1)：每天签到跑完后自动采集一次，无需手工执行。

### 无人值守：Windows 计划任务示例

签到支持锁屏与窗口最小化执行，可用任务计划程序每日定时运行。任务以**当前登录用户**运行（默认“只在用户登录时运行”，锁屏不影响）；不要选“不管用户是否登录都要运行”——该模式运行在非交互会话，与已在该用户会话中运行的 Edge Profile 会冲突，未验证支持。

第一步：保存签到脚本（例：`scripts\daily-checkin.ps1`，按实际修改仓库路径与账号别名）。脚本内容保持纯 ASCII——Windows PowerShell 5.1 按 ANSI 解析无 BOM 的 `.ps1`，中文字符串会乱码；若要添加中文，需将文件保存为「UTF-8 with BOM」：

完整脚本见仓库 [`scripts/daily-checkin.ps1`](file:///d:/916938/zenxbrowser/scripts/daily-checkin.ps1)，核心部分：

```powershell
param(
  # Retry accounts that already failed today. Only do this after signing them in manually -
  # a failed checkin can leave the account logged out on the site, and re-running blind
  # keeps it stuck (IDENTITY_MISMATCH on every later attempt).
  [switch]$Force
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8  # decode UTF-8 output from node

$repo    = "D:\916938\zenxbrowser"          # zenx repo path
$aliases = @("edge-1", "edge-2", "edge-3", "edge-4", "edge-5", "edge-6", "edge-7", "edge-8", "edge-9", "edge-10",
             "edge-p3", "edge-p11", "edge-p12", "edge-p13", "edge-p14")  # all bound accounts with a verified site identity
$cli     = Join-Path $repo "src\cli.ts"
$log     = Join-Path $repo ".zenx\logs\checkin-$(Get-Date -Format yyyyMMdd).log"
New-Item (Split-Path $log) -ItemType Directory -Force | Out-Null

# Site rate limit: after ~10 logins in quick succession it starts refusing sign-in.
# Each checkin performs exactly one login, so pause after every $loginLimit logins.
$loginLimit   = 10
$coolDownMin  = 11

# A failed checkin can leave the account logged out on the site. Re-running blind then
# fails again with IDENTITY_MISMATCH and never recovers, so accounts that already failed
# today are skipped until the next day (or until -Force after a manual sign-in).
$stateFile = Join-Path $repo ".zenx\logs\failed-$(Get-Date -Format yyyyMMdd).txt"
$skip = @{}
if (Test-Path $stateFile) {
  if ($Force) { Remove-Item $stateFile -Force }
  else { Get-Content $stateFile | Where-Object { $_ } | ForEach-Object { $skip[$_] = $true } }
}

function Mark-Failed {
  param([string]$Alias)
  Add-Content -Path $stateFile -Encoding UTF8 -Value $Alias
}

function Invoke-Zenx {
  param([string[]]$Arguments)
  & node $cli @Arguments --json 2>&1 | ForEach-Object { "$_" } |
    Add-Content -Path $log -Encoding UTF8
  return $LASTEXITCODE
}

# Safety net: a leftover session means a leftover Agent Window on the desktop.
# checkin normally stops its own session, but a crash or timeout can skip that.
function Close-LeftoverSessions {
  $list = & bsk session list 2>&1 | Out-String
  if ($list -match "no active sessions") { return 0 }
  $ids = [regex]::Matches($list, '\b([a-z0-9]{4})\b') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  foreach ($id in $ids) {
    Add-Content -Path $log -Encoding UTF8 -Value "--- closing leftover session $id"
    & bsk session stop $id 2>&1 | Out-Null
  }
  return $ids.Count
}

$failed = @()
$logins = 0
foreach ($alias in $aliases) {
  Add-Content -Path $log -Encoding UTF8 -Value "`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $alias ====="

  if ($skip.ContainsKey($alias)) {
    Add-Content -Path $log -Encoding UTF8 -Value "--- skipped: failed earlier today; sign in manually then rerun with -Force"
    $failed += "${alias}(skipped)"
    continue
  }

  $ensure = Invoke-Zenx @("accounts", "ensure-online", $alias)  # launch Edge profile if offline
  # Not marked failed: checkin never ran, so the account state is untouched and a
  # later retry is safe (an offline Edge profile is often just slow to start).
  if (0 -ne $ensure) { $failed += "${alias}(offline)"; continue }

  # No window fiddling before checkin: zenx probes the page itself and switches to
  # in-page DOM calls when the window is hidden (locked screen / no interactive desktop).

  # Pause before the login that would exceed the site's burst limit.
  if ($logins -gt 0 -and $logins % $loginLimit -eq 0) {
    Add-Content -Path $log -Encoding UTF8 -Value "--- login limit reached ($logins logins); cooling down $coolDownMin min"
    Start-Sleep -Seconds ($coolDownMin * 60)
  }

  # Not every failure means the account got logged out (e.g. CHECKIN_UNCONFIRMED completes
  # the whole flow). But every one of them still produced a login attempt, so be
  # conservative: mark it and require a manual sign-in before retrying the same day.
  if (0 -ne (Invoke-Zenx @("accounts", "checkin", $alias))) { $failed += $alias; Mark-Failed $alias }
  $logins++
}

# Always leave a clean desktop, even when a checkin failed part-way through.
$leftover = Close-LeftoverSessions
if ($leftover -gt 0) {
  Add-Content -Path $log -Encoding UTF8 -Value "--- closed $leftover leftover session(s)"
}
Add-Content -Path $log -Encoding UTF8 -Value "===== failed: $($failed -join ', ') ====="
if ($failed.Count -eq 0) { exit 0 }
# 2 = only accounts that were already known-bad before this run; nothing new broke.
# 1 = at least one account failed during this run and needs attention.
$onlySkipped = @($failed | Where-Object { $_ -like "*(skipped)*" }).Count -eq $failed.Count
if ($onlySkipped) { exit 2 } else { exit 1 }
```

第二步：注册每日 09:05 运行的计划任务（错过时段——关机/睡眠——开机后自动补跑，笔记本电池供电也执行）：

```powershell
$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"D:\916938\zenxbrowser\scripts\daily-checkin.ps1`""
$trigger  = New-ScheduledTaskTrigger -Daily -At 09:05
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ZenX 每日签到" -Action $action -Trigger $trigger -Settings $settings
```

说明：

- 首次配置后手动运行一次验证全链路：`powershell -ExecutionPolicy Bypass -File scripts\daily-checkin.ps1`（前提：`zenx doctor` 通过、各账号已绑定且配置了启动参数）。
- 账号串行执行、互不阻塞；单账号失败不中断后续账号。
- **签完释放实例**：脚本对本轮 `ensure-online` 拉起的账号自动加 `--close-after`，整个 Edge 进程退出；你自己本来就开着的 Edge 不会被关（同一 Profile，关了会丢你的标签页与未保存内容）。
- **全程开启防休眠**（进程级，不改电源计划）：跑几十分钟、中间还有 11 分钟冷却，休眠会让后续账号全部中断。`-NoSleepGuard` 关闭。
- 退出码：`0` 全部成功；`1` 本次有新失败，需要关注；`2` 本次无新失败，只是跳过了当天早前已失败的账号。“任务计划程序 → 上次运行结果”非 0 即有失败。
- 日志按天追加在 `.zenx\logs\checkin-日期.log`（`.zenx` 已被 git 忽略）。
- **失败账号当天不再自动重试**：签到失败可能让账号停留在“已登出”状态，盲目重跑只会反复报 `IDENTITY_MISMATCH`、越跑越糟。失败的别名会记入 `.zenx\logs\failed-日期.txt`，当天后续运行直接跳过（日志里标 `skipped`）。人工完成一次 GitHub 登录后，用 `daily-checkin.ps1 -Force` 清掉该文件再跑；不处理的话次日自动恢复（文件名按日期变化）。
- 离线（`offline`）**不**计入失败名单：`checkin` 还没执行，账号状态未被触碰，重试是安全的（Edge Profile 常常只是启动慢）。
- 遇 `MANUAL_INTERVENTION_REQUIRED` 的账号同样适用上面的跳过逻辑：人工完成一次 GitHub 登录后用 `-Force` 恢复。

### 常见错误码

| 错误码 | 含义 |
|---|---|
| `IDENTITY_MISMATCH` | 页面身份与绑定身份不符（且页面不是登录页）；未执行退出。登录页由 checkin 自动点「使用 GitHub 继续」登录，不会走到这里 |
| `WINDOW_NOT_INTERACTIVE` | 无法探测页面状态（evaluate 失败或响应非法）；未执行点击 |
| `SITE_TIMEOUT` | 导航控制台连续失败（已重试 3 次，每次间隔 2s）；未执行点击 |
| `DOM_INTERACT_FAILED` | DOM 直调未能在页面中找到目标元素；未继续 |
| `ANIMATION_SETTLE_FAILED` | 动画收敛 evaluate 失败或响应非法；未执行点击 |
| `ANNOUNCEMENT_CLOSE_FAILED` | 两次尝试后公告弹窗仍未关闭 |
| `LOGOUT_FAILED` | 点击退出后未出现登录页 |
| `MANUAL_INTERVENTION_REQUIRED` | 出现 GitHub 授权/验证页，需人工处理 |
| `LOGIN_TIMEOUT` | 重新登录轮询超 60s（多数是站点限流的间接症状，可用 `zenx accounts login` 恢复登录态） |
| `LOGIN_RATE_LIMITED` | 站点登录限流（页面明示“登录次数过多/请稍后再试”）；必须等待冷却，不可连续重试 |
| `CHECKIN_UNCONFIRMED` | 流程完成但余额未变且无“签到成功”提示 |
| `RECHECK_EVAL_FAILED` | 复查时读不到页面正文；未给出额度结论 |
| `RECHECK_TIMEOUT` | 复查总预算耗尽 |

## 开发

```powershell
npm test      # 全量测试（node --test）
npm run check # 语法检查
```
