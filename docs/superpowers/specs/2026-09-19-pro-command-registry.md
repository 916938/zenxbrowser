# 第 1 项：browserskill-pro 命令清单可生成 / 可校验

日期：2026-09-19
仓库：`d:\916938\browserskill-pro`
来源：bb-browser 的 `packages/shared/src/commands.ts`（统一命令注册表）调研结论

## 问题

同一份"命令事实"目前手工维护在四处：

1. `skill/SKILL.md` — Quick action map（Action → bsk 命令 → 用途）+ Additional BrowserSkill capabilities
2. `skill/references/protocol.md` — Actions 表（Action / 命令 / 参数 / 用途）+ Additional BrowserSkill Actions
3. `README.md` / `README_ZH.md` — 特性表
4. `CHANGELOG.md` / `changed.md` — 变更记录（人工，保持人工）

2026-09-18 已因漂移做过一次大同步（补 1.1.0 条目、重写双语 README、把 `browsers close` 补进 4 个文件）。同一类工作会反复发生。

## 目标

- 命令事实**只写一处**（registry），SKILL.md 与 protocol.md 中的表格由它生成。
- 有 `--check` 校验：文档与 registry 不一致时非零退出，可接入现有测试与 CI。
- **不牺牲手写内容**：SKILL.md 里的决策树、注意事项、红线是人工撰写的，必须原样保留。

## 关键设计决策

**生成范围用标记界定**，只覆盖标记之间的表格，标记之外一律不动：

```markdown
<!-- BEGIN GENERATED: action-map -->
| Action | BrowserSkill Command | Use when |
|---|---|---|
...
<!-- END GENERATED: action-map -->
```

理由：SKILL.md 是给 Agent 读的操作手册，其中大量"用的时候要注意什么"无法从元数据推导，全量生成会让文档退化。

## 具体输出物

| # | 路径 | 类型 | 说明 |
|---|---|---|---|
| 1 | `skill/references/command-registry.json` | 新增 | **单一数据源**。命令清单 + tier + 参数 + 用途 |
| 2 | `scripts/generate_command_docs.py` | 新增 | 生成器；`--check` 为校验模式 |
| 3 | `skill/SKILL.md` | 修改 | 两处表格改为标记区域，内容由生成器填充 |
| 4 | `skill/references/protocol.md` | 修改 | Actions 表、Additional Actions 表改为标记区域 |
| 5 | `tests/test_command_registry.py` | 新增 | 见"验收" |
| 6 | `AGENTS.md` | 修改 | 说明"改命令先改 registry，再跑生成器"，并列出命令 |
| 7 | `changed.md` + `CHANGELOG.md` | 修改 | 记录本次改动 |

### 1. `skill/references/command-registry.json` 结构

```json
{
  "version": 1,
  "tiers": {
    "0.2.3": "已发布基线（2026-09-08）",
    "0.2.4+": "0.2.3 之后合入，需更新构建",
    "fork": "仅 916938/browserskill-new"
  },
  "actions": [
    {
      "action": "observe",
      "command": "bsk observe",
      "tier": "0.2.3",
      "args": ["max_depth", "max_tokens", "probe_hover"],
      "purpose": "Read a semantic VOM view: URL, title, text, controls, hover surfaces, and @e refs. Preferred first observation.",
      "additional": false
    }
  ]
}
```

- `additional: true` 的项进 "Additional ..." 表，否则进主表。
- `tier` 取值必须落在 `tiers` 里（生成器校验）。
- 现有命令全部录入（SKILL.md 主表约 12 条 + Additional 约 25 条，含 `browsers close`）。

### 2. `scripts/generate_command_docs.py`

```bash
python3 scripts/generate_command_docs.py            # 就地更新标记区域
python3 scripts/generate_command_docs.py --check    # 只校验，不一致则 exit 1
```

行为约束：
- 只重写 `<!-- BEGIN GENERATED: <id> -->` 与 `<!-- END GENERATED: <id> -->` 之间的内容；找不到标记或标记不成对 → 报错退出。
- 生成是**幂等**的：连续两次运行，第二次无变更。
- 输出保持 LF 之外的原文件行尾习惯（pro 仓库文件为 CRLF，不得整体改行尾）。
- 零第三方依赖（pro 现有 Python helper 全部只用标准库，必须保持）。

## 验收标准

1. `python3 -m unittest discover -s tests -v` 全绿；现有 292 项（1 skipped）不回归，新增用例数量待实现后确定。
2. 初次接入后 `generate_command_docs.py --check` **必须直接通过**（即：先按现有文档反向校准 registry，再切到生成模式，避免"一上就红"）。
3. `tests/test_command_registry.py` 至少覆盖：
   - registry 自身 schema 校验（tier 合法、action 唯一、必填字段齐全）
   - 生成器幂等（跑两次输出一致）
   - `--check` 能发现漂移：临时改一行 SKILL.md → 退出码非 0；还原后 → 退出码 0
   - 标记缺失/不成对 → 报错而非静默跳过
4. 生成后的 SKILL.md / protocol.md 与改动前**人工核对一遍 diff**，确认只有表格行变化、手写段落未被动过。
5. 文档更新：`AGENTS.md` 说明新流程；`changed.md` 记录；`CHANGELOG.md` 加到 `[Unreleased]`。

## 不在本次范围

- README 双语特性表也改生成（先不动；特性表是"卖点描述"而非命令事实，强行生成会失真）。
- `CHANGELOG.md` / `changed.md` 保持人工。
- 任何 bsk CLI / 扩展侧的改动（本项纯文档工程，不动协议）。
- 推送远端（除非另行要求）。
