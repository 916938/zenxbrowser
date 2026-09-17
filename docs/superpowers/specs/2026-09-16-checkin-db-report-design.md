# 签到统计数据库与报表前台设计

日期：2026-09-16

## 目标

把每个账号每次签到的结果（时间、身份、打卡前后余额、是否到账、失败原因）保存进 SQLite 数据库，并提供本地网页报表查看。

用户已确认的两个决策：

- **数据源：只写 SQLite**，弃用 JSONL（`zenxbrowser/checkin-history.jsonl` 不再作为账本）。
- **前台：本地网页 + 内置服务器**，加 `zenx report` 命令启动。

## 背景

现有 `src/history.ts` 实现的是 JSONL 追加写入。本次改造把它替换为 SQLite，并新增报表。

环境已验证：Node 24.16.0，内置 `node:sqlite`（`DatabaseSync`）可用，**无需新增任何 npm 依赖**（项目目前零依赖，应保持）。

## 架构

```
src/db.ts       新增——SQLite 读写（建表、插入、查询聚合）
src/report.ts   新增——本地 HTTP 服务器 + 内嵌网页
src/cli.ts      修改——注册 `zenx report` 命令
src/checkin.ts  修改——写入目标从 JSONL 改为 SQLite
src/history.ts  删除——被 db.ts 取代
test/db.test.ts 新增
test/checkin.test.ts 修改——historyFile 依赖改为 dbFile
```

数据文件：`zenxbrowser/checkin.db`（与项目根同级目录，和原 JSONL 位置一致）。

## 数据模型

```sql
CREATE TABLE IF NOT EXISTS checkins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  time           TEXT    NOT NULL,   -- ISO 8601 UTC
  alias          TEXT    NOT NULL,
  instance_id    TEXT    NOT NULL,
  identity       TEXT    NOT NULL,
  ok             INTEGER NOT NULL,   -- 0/1
  balance_before REAL,               -- NULL = 未提取到
  balance_after  REAL,
  credited       INTEGER NOT NULL,   -- 0/1，是否确认到账
  error_code     TEXT                -- 成功为 NULL
);
CREATE INDEX IF NOT EXISTS idx_checkins_time  ON checkins(time);
CREATE INDEX IF NOT EXISTS idx_checkins_alias ON checkins(alias, time);
```

要点：

- 余额用 `REAL`，缺失存 `NULL`（绝不写 0，避免与真实余额混淆）。
- `ok`/`credited` 用 `INTEGER`（SQLite 无布尔）。
- 建表用 `IF NOT EXISTS`，重复启动安全；启用 WAL 提升并发读性能。
- **写入失败不改变签到结果**（与现有 history 行为一致：账本不能反过来影响打卡）。

## CLI 接口

```
zenx report [--port 8787] [--open]
```

- 默认端口 8787，被占用则提示并退出（不自动换端口，避免用户找不到）。
- `--open` 自动用系统默认浏览器打开。
- 只监听 `127.0.0.1`，不对外暴露。
- 启动后打印访问地址；`Ctrl+C` 停止。

## HTTP 接口

| 路由 | 说明 |
|---|---|
| `GET /` | 网页（HTML 内嵌，无外部依赖） |
| `GET /api/summary` | 每个账号的汇总：总签到数、成功数、当前余额、累计到账、最近打卡时间 |
| `GET /api/checkins?alias=&limit=` | 明细列表，按时间倒序；可按账号过滤 |

无鉴权（仅本机回环，与项目其他本地服务的定位一致）。

## 网页

单文件内嵌 HTML，零外部依赖（不引 CDN，离线可用）。包含：

1. **汇总卡片**：账号数、总签到次数、成功到账次数、累计获得额度。
2. **账号表格**：别名、身份、当前余额、累计到账、最近打卡、成功率。
3. **明细表格**：时间、账号、打卡前、打卡后、增减、结果；失败行标红并显示错误码。
4. **余额趋势图**：用内联 SVG 手绘折线（不引图表库），每个账号一条。
5. 时间显示为本地时间（`toLocaleString`），并标注原始数据为 UTC。
6. 空数据时显示友好提示，而不是空白页。

## 统计口径

- **累计到账** = 所有 `balance_after - balance_before > 0` 的记录求和（只统计实际增长）。
- **当前余额** = 该账号最近一条 `balance_after` 非 NULL 的记录。
- **成功率** = `credited = 1` 的次数 / 总次数。
- 当天重复签到（余额不变但 `credited = 1`，靠"签到成功"提示判定）计入成功，但不计入累计到账金额——这与站点实际发放规则一致。

## 测试策略

`test/db.test.ts`：

- 建表幂等（重复调用不报错）、插入与查询往返。
- 余额 NULL 不写成 0；`ok`/`credited` 布尔 ↔ 整数正确转换。
- 聚合口径：累计到账只算正增长；当前余额取最近一条非 NULL。
- 按账号过滤、按时间排序、limit 生效。
- 空库时汇总返回空数组而非报错。
- 并发/连续写入不丢记录。

`test/checkin.test.ts`：把 `historyFile` 依赖改为 `dbFile`（临时目录），并保留"测试不得污染项目根真实数据库"的守护断言。

## 非目标

- 不做数据修改界面（只读报表）。
- 不做定时刷新（手动刷新页面即可）。
- 不迁移已有的 `checkin-history.jsonl`（其中 176 条已被确认全是测试数据，无真实记录，直接弃用；原文件备份保留）。
- 不做导出 CSV（后续需要再加）。
