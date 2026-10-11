import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readStore } from "./core.ts";
import { balanceSeries, dailyTotals, listCheckins, rangeSummary, RECENT_SPENT_DAYS, summarizeAccounts } from "./db.ts";

export type ReportOptions = {
  port?: number;
  dbFile?: string;
  /** 账号目录；用于把"已绑定账号"与"账本里有记录的账号"对照。 */
  home?: string;
  /** 端口被占用等启动失败时的回调（CLI 用于输出错误）。 */
  onError?: (error: NodeJS.ErrnoException) => void;
  onStart?: (url: string) => void;
};

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZenX 签到统计</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#252a34; --text:#e6e8ee; --dim:#98a0b3; --ok:#3fb950; --bad:#f85149; --accent:#58a6ff; }
  * { box-sizing:border-box }
  body { margin:0; padding:24px; background:var(--bg); color:var(--text);
         font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Helvetica Neue","Microsoft YaHei",sans-serif }
  h1 { font-size:20px; margin:0 0 4px }
  h2 { font-size:15px; margin:28px 0 10px; color:var(--dim); font-weight:600 }
  h3 { font-size:13px; margin:18px 0 8px; color:var(--dim); font-weight:600 }
  .sub { color:var(--dim); font-size:12px; margin-bottom:20px }
  .cards { display:flex; gap:12px; flex-wrap:wrap }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 18px; min-width:150px }
  .card .k { color:var(--dim); font-size:12px }
  .card .v { font-size:22px; font-weight:600; margin-top:2px }
  /* 一个卡片里按站点分行：两个站点的额度不能互转，合起来显示会误导 */
  .card .row { display:flex; justify-content:space-between; gap:16px; font-size:14px; margin-top:3px }
  .card .row:first-of-type { margin-top:2px }
  .card .row .n { color:var(--dim); font-size:12px }
  .card .row .n b { color:var(--accent); font-weight:600 }
  .card .multi .v { display:none }
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:10px; overflow:hidden }
  th,td { padding:8px 12px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap }
  th { color:var(--dim); font-weight:600; font-size:12px; background:#12151b }
  tr:last-child td { border-bottom:none }
  tr.total td { border-top:2px solid var(--line); font-weight:600; background:#12151b }
  .ok { color:var(--ok) } .bad { color:var(--bad) }
  .clickable { cursor:pointer } .clickable:hover { text-decoration:underline }
  .gain { color:var(--ok); font-weight:600 }
  .muted { color:var(--dim) }
  .empty { padding:32px; text-align:center; color:var(--dim) }
  svg { background:var(--card); border:1px solid var(--line); border-radius:10px; display:block }
  a { color:var(--accent) }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:var(--dim) }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px }
</style>
</head>
<body>
<h1>ZenX 签到统计</h1>
<div class="sub" id="meta">加载中…</div>

<div class="cards" id="cards"></div>

<h2>账号汇总</h2>
<div class="sub">累计消耗 = 站点「历史消耗」；近期消耗 = 最近 ${RECENT_SPENT_DAYS} 天，同一算法相对 ${RECENT_SPENT_DAYS} 天前的增量（窗口内无观测点显示 —）。</div>
<div id="summary"></div>

<h2>每日总额</h2>
<div id="daily"></div>

<h2>周 / 月对比</h2>
<div id="ranges"></div>

<h2>余额趋势</h2>
<div id="chart"></div>

<h2>打卡明细</h2>
<div id="detail"></div>

<script>
const RECENT_DAYS = ${RECENT_SPENT_DAYS};
const COLORS = ["#58a6ff","#3fb950","#f0883e","#a371f7","#f85149","#39c5cf","#e3b341","#db61a2"];
// 站点：账本 alias 形如 "edge-6" / "edge-6@<站点键>"。同一个 Edge Profile 可以在
// 多个站点上各有一个账号，两边的余额独立（不能互转），所以处处按站点分开显示。
// 前台只显示脱敏代号（router-A / router-B），真实平台名不出现在页面与注释里。
const SITE_NAMES = { agentrouter: "router-A", anyrouter: "router-B" };
const SITE_ORDER = ["agentrouter", "anyrouter"];
const siteOf = a => { const s = String(a ?? ""); const i = s.lastIndexOf("@"); return i > 0 ? s.slice(i + 1) : "agentrouter"; };
const baseOf = a => { const s = String(a ?? ""); const i = s.lastIndexOf("@"); return i > 0 ? s.slice(0, i) : s; };
const siteName = s => SITE_NAMES[s] || s;
const siteRank = s => { const i = SITE_ORDER.indexOf(s); return i < 0 ? SITE_ORDER.length : i; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money = v => v === null || v === undefined ? '<span class="muted">—</span>' : "$" + Number(v).toFixed(2);
const local = t => t ? new Date(t).toLocaleString("zh-CN", { hour12:false }) : '<span class="muted">—</span>';
const gain = v => v ? '<span class="gain">+$' + Number(v).toFixed(2) + '</span>' : '<span class="muted">$0.00</span>';
const spentCell = v => (v === null || v === undefined)
  ? '<span class="muted">—</span>' : '<span class="bad">-$' + Number(v).toFixed(2) + '</span>';
// 余额是"某个时刻的读数"而不是实时数：把它观测于哪天标出来，避免把上周的数字当今天。
const observedAt = t => {
  if (!t) return '<span class="muted">—</span>';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  const label = d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
    + " " + d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  return today ? '<span class="ok">' + label + '</span>' : '<span class="muted">' + label + '</span>';
};
const netCell = v => (v === null || v === undefined) ? '<span class="muted">—</span>'
  : v >= 0 ? '<span class="gain">+$' + v.toFixed(2) + '</span>'
           : '<span class="bad">-$' + Math.abs(v).toFixed(2) + '</span>';

async function load() {
  const [sum, rows, series, ranges, daily, bound] = await Promise.all([
    fetch("/api/summary").then(r => r.json()),
    fetch("/api/checkins?limit=500").then(r => r.json()),
    fetch("/api/series").then(r => r.json()),
    fetch("/api/ranges").then(r => r.json()),
    fetch("/api/daily").then(r => r.json()),
    fetch("/api/accounts").then(r => r.json()).catch(() => ({ ok: false, accounts: [] })),
  ]);

  const accounts = sum.length;
  const boundCount = bound.accounts ? bound.accounts.length : 0;
  const missing = bound.accounts
    ? bound.accounts.filter(a => !sum.some(s => s.alias === a.alias)).map(a => a.alias)
    : [];
  const totalRuns = sum.reduce((a, s) => a + s.total, 0);
  const totalCredited = sum.reduce((a, s) => a + s.credited, 0);
  const totalGain = sum.reduce((a, s) => a + s.totalGained, 0);
  document.getElementById("meta").textContent =
    // 一个 Edge Profile 可以在多个站点上各有账号，账本里每个"站点账号"一行，
    // 所以这里说"站点账号"而不是"账号"——否则数字会比已绑定的 Profile 数多，看着像出错。
    (accounts ? accounts + " 个站点账号有数据 · 共 " + totalRuns + " 次打卡 · " : "暂无数据 · ")
    + "数据为 UTC，显示已转本地时间";
  if (bound.ok && missing.length) {
    document.getElementById("meta").innerHTML +=
      ' · <span class="bad">' + missing.length + ' 个已绑定账号暂无观测点：' + esc(missing.join("、")) + '</span>';
  }
  const latestDay = daily.length ? daily[daily.length - 1] : null;
  // 按站点聚合：两个站点的额度不能互转，加起来得到的"总额"没有意义，
  // 因此每个卡片按站点各给一行，而不是合成一个数字。
  // 各合计都只累加"有读数"的账号：没有观测点的账号是缺失而不是 0，凑进去会让合计假装精确。
  const siteStats = new Map();
  for (const s of sum) {
    const site = siteOf(s.alias);
    const st = siteStats.get(site) || { accounts: 0, runs: 0, credited: 0, gain: 0,
      spent: 0, hasSpent: false, recent: 0, hasRecent: false, balance: 0, balAccounts: 0, freshest: null };
    st.accounts += 1;
    st.runs += s.total || 0;
    st.credited += s.credited || 0;
    st.gain += s.totalGained || 0;
    if (s.totalSpent !== null && s.totalSpent !== undefined) { st.spent += s.totalSpent; st.hasSpent = true; }
    if (s.recentSpent !== null && s.recentSpent !== undefined) { st.recent += s.recentSpent; st.hasRecent = true; }
    if (s.currentBalance !== null && s.currentBalance !== undefined) { st.balance += s.currentBalance; st.balAccounts += 1; }
    if (s.balanceTime && (!st.freshest || s.balanceTime > st.freshest)) st.freshest = s.balanceTime;
    siteStats.set(site, st);
  }
  const sitesPresent = [...siteStats.keys()].sort((a, b) => siteRank(a) - siteRank(b));
  const perSiteCard = (title, pick) =>
    '<div class="card multi"><div class="k">' + title + '</div><div class="v"></div>'
    + sitesPresent.map(site =>
        '<div class="row"><span class="n"><b>' + esc(siteName(site)) + '</b></span>'
        + '<span>' + pick(siteStats.get(site), site) + '</span></div>').join("")
    + '</div>';
  const dash = '<span class="muted">—</span>';
  document.getElementById("cards").innerHTML = [
    perSiteCard("账号数", st => st.accounts + " 个"),
    perSiteCard("打卡次数", st => st.runs),
    perSiteCard("成功到账", st => st.credited),
    perSiteCard("累计获得", st => '<span class="gain">+$' + st.gain.toFixed(2) + '</span>'),
    perSiteCard("历史总消耗", st => st.hasSpent ? spentCell(st.spent) : dash),
    perSiteCard("余额总额", (st, site) => {
      if (!st.balAccounts) return dash;
      const note = latestDay && latestDay.bySite && latestDay.bySite[site]
        ? ' <span class="muted" style="font-size:11px">' + latestDay.bySite[site].balanceAccounts + ' 个账号</span>'
        : "";
      return money(st.balance) + note;
    }),
    perSiteCard("最近一日消耗", (st, site) => {
      const d = latestDay && latestDay.bySite ? latestDay.bySite[site] : null;
      return d ? spentCell(d.spentSum) : dash;
    }),
    perSiteCard("最近 " + RECENT_DAYS + " 天消耗", st => st.hasRecent ? spentCell(st.recent) : dash),
  ].join("");

  const notObserved = bound.accounts
    ? bound.accounts.filter(a => !sum.some(s => s.alias === a.alias))
        .map(a => ["<b>" + esc(a.alias) + "</b>", esc(siteName("agentrouter")), esc(a.identity),
                   '<span class="muted">从未采集</span>',
                   '<span class="muted">—</span>', '<span class="muted">$0.00</span>', '<span class="muted">—</span>',
                   '<span class="muted">—</span>',
                   0, 0, "—", "—", '<span class="muted">先跑一次 snapshot / checkin</span>'])
    : [];
  // 同一个 Profile 在多个站点上的行挨在一起（一眼看出这个 Profile 的两笔余额），
  // 组间按该 Profile 的最高余额降序——仍是"钱多的在前"。没读到余额的沉到最后：
  // 它们是"未知"而不是"余额 0"，混在中间会被误读成最穷。
  const groupMax = new Map();
  for (const s of sum) {
    const key = baseOf(s.alias);
    const v = s.currentBalance;
    if (v !== null && v !== undefined) {
      const cur = groupMax.get(key);
      if (cur === undefined || v > cur) groupMax.set(key, v);
    }
  }
  const byBalance = sum.slice().sort((a, b) => {
    const ga = baseOf(a.alias), gb = baseOf(b.alias);
    if (ga !== gb) {
      const xa = groupMax.get(ga), xb = groupMax.get(gb);
      if (xa === undefined && xb === undefined) return ga.localeCompare(gb);
      if (xa === undefined) return 1;
      if (xb === undefined) return -1;
      return xb - xa || ga.localeCompare(gb);
    }
    return siteRank(siteOf(a.alias)) - siteRank(siteOf(b.alias));
  });
  document.getElementById("summary").innerHTML = (accounts || notObserved.length) ? table([
    ["账号","站点","身份","当前余额","余额观测","累计到账","累计消耗","近期消耗","打卡次数","成功","成功率","最近打卡","最近结果"],
    ...byBalance.map(s => [
      "<b>" + esc(baseOf(s.alias)) + "</b>", esc(siteName(siteOf(s.alias))), esc(s.identity),
      money(s.currentBalance), observedAt(s.balanceTime),
      s.totalGained ? '<span class="gain">+$' + s.totalGained.toFixed(2) + '</span>' : '<span class="muted">$0.00</span>',
      spentCell(s.totalSpent),
      spentCell(s.recentSpent),
      s.total, s.credited, (s.total ? Math.round(s.credited / s.total * 100) : 0) + "%",
      local(s.lastTime),
      s.lastOk === null ? "—" : s.lastOk
        ? '<span class="ok">成功</span>'
        : '<span class="bad">失败 ' + esc(s.lastErrorCode || "") + '</span>',
    ]),
    ...notObserved,
  ], accounts ? sitesPresent.map(site => {
    const st = siteStats.get(site);
    // 各账号"各自最近一次观测"之和：观测点不在同一时刻，所以它是一组读数的合计，不是实时余额。
    // 两站的额度不能互转，因此每个站点各一行合计，不给跨站点的总数。
    return ["<b>合计 " + esc(siteName(site)) + "</b>", esc(siteName(site)),
      '<span class="muted">' + st.accounts + ' 个账号</span>',
      '<span title="各账号各自最近一次观测余额之和">' + money(st.balAccounts ? st.balance : null) + '</span>',
      '<span title="该站点里最新的一次余额观测">' + observedAt(st.freshest) + '</span>',
      gain(st.gain), spentCell(st.hasSpent ? st.spent : null), spentCell(st.hasRecent ? st.recent : null),
      st.runs, st.credited, (st.runs ? Math.round(st.credited / st.runs * 100) : 0) + "%",
      '<span class="muted">—</span>', '<span class="muted">—</span>'];
  }) : []) : '<div class="empty">还没有签到记录，先运行一次 <code>zenx accounts checkin</code> 吧。</div>';

  document.getElementById("daily").innerHTML = drawDaily(daily);
  bindSpentDetail(daily);

  document.getElementById("ranges").innerHTML = drawRanges(ranges);

  document.getElementById("chart").innerHTML = drawChart(series);

  document.getElementById("detail").innerHTML = rows.length ? table([
    ["时间","账号","站点","打卡前","打卡后","增减","结果"],
    ...rows.map(r => {
      const delta = (r.balanceAfter !== null && r.balanceBefore !== null)
        ? r.balanceAfter - r.balanceBefore : null;
      return [
        local(r.time), esc(baseOf(r.alias)), esc(siteName(siteOf(r.alias))),
        money(r.balanceBefore), money(r.balanceAfter),
        delta === null ? '<span class="muted">—</span>'
          : delta > 0 ? '<span class="gain">+$' + delta.toFixed(2) + '</span>'
          : delta < 0 ? '<span class="bad">-$' + Math.abs(delta).toFixed(2) + '</span>'
          : '<span class="muted">±$0.00</span>',
        r.ok ? '<span class="ok">成功</span>'
             : '<span class="bad">失败 ' + esc(r.errorCode || "") + '</span>',
      ];
    })
  ]) : '<div class="empty">暂无明细</div>';
}

function drawDaily(rows) {
  if (!rows.length) return '<div class="empty">还没有每日快照，先跑一次 <code>zenx accounts snapshot --all</code>。</div>';
  const body = [];
  // 一天按站点分成多行：两站的余额不能互转，合成一个数会误导。
  for (const r of rows.slice().reverse()) {
    const sites = r.bySite ? Object.keys(r.bySite).sort((a, b) => siteRank(a) - siteRank(b)) : [];
    const groups = sites.length
      ? sites.map(s => ({ site: s, d: r.bySite[s] }))
      // 老账本没有 bySite：退回整行合计，不至于显示空白
      : [{ site: null, d: { balanceSum: r.balanceSum, spentSum: r.spentSum, creditedSum: r.creditedSum,
                            balanceAccounts: r.balanceAccounts, spentAccounts: r.spentAccounts } }];
    for (const g of groups) {
      const d = g.d;
      const detailCount = (r.spentDetails || []).filter(x => g.site === null || siteOf(x.alias) === g.site).length;
      const spentHtml = (d.spentSum === null || d.spentSum === undefined)
        ? '<span class="muted">—</span>'
        : detailCount
          ? '<span class="bad clickable" data-spent-day="' + esc(r.day) + '"'
            + (g.site ? ' data-spent-site="' + esc(g.site) + '"' : '')
            + ' title="点击展开各账号消耗明细">-$' + Number(d.spentSum).toFixed(2) + ' ▸</span>'
          : '<span class="bad">-$' + Number(d.spentSum).toFixed(2) + '</span>';
      body.push([
        "<b>" + esc(r.day) + "</b>",
        g.site ? esc(siteName(g.site)) : '<span class="muted">全部</span>',
        money(d.balanceSum),
        spentHtml,
        gain(d.creditedSum),
        (d.balanceAccounts || 0) + " 个余额 / " + (d.spentAccounts || 0) + " 个消耗",
      ]);
    }
  }
  return table([["日期", "站点", "余额总额", "当日消耗", "当日签到到账", "覆盖账号"], ...body]);
}

/** 点击"当日消耗"展开/收起各账号消耗明细。 */
function bindSpentDetail(daily) {
  document.getElementById("daily").addEventListener("click", (e) => {
    const el = e.target.closest("[data-spent-day]");
    if (!el) return;
    const day = el.dataset.spentDay;
    const row = el.closest("tr");
    const existing = row.nextElementSibling;
    if (existing && existing.dataset.detailRow) {
      existing.remove();
      el.innerHTML = el.innerHTML.replace(" ▾", " ▸");
      return;
    }
    const dayData = daily.find(d => d.day === day);
    if (!dayData || !dayData.spentDetails) return;
    // 站点过滤：一天按站点分成多行，展开时只显示该站点的账号
    const site = el.dataset.spentSite || null;
    const details = dayData.spentDetails.filter(d => !site || siteOf(d.alias) === site);
    if (!details.length) return;
    const detailRow = document.createElement("tr");
    detailRow.dataset.detailRow = "1";
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.style.cssText = "padding:8px 12px;background:#12151b";
    cell.innerHTML = details.map(d =>
      '<div style="display:flex;justify-content:space-between;padding:2px 0;gap:12px">' +
      '<span>' + esc(baseOf(d.alias)) + ' <span class="muted">' + esc(siteName(siteOf(d.alias))) + '</span></span>' +
      '<span class="bad">-$' + d.spent.toFixed(2) + '</span>' +
      '<span class="muted" style="font-size:11px">' + (d.source === "snapshot" ? "快照" : "签到") + '</span>' +
      '</div>'
    ).join("");
    detailRow.appendChild(cell);
    row.after(detailRow);
    el.innerHTML = el.innerHTML.replace(" ▸", " ▾");
  });
}

function drawRanges(ranges) {
  const note = '<div class="sub">到账 = 签到带来的余额增长；消耗优先取站点「历史消耗」的区间增量，' +
               '快照缺失时由签到记录反推（上次余额 + 25 − 本次余额）。' +
               '每天跑一次 <code>zenx accounts snapshot --all</code> 可让消耗更精确。</div>';
  return note + [["本周 vs 上周", ranges.week], ["本月 vs 上月", ranges.month]]
    .map(([title, cmp]) => rangeSection(title, cmp)).join("");
}

function rangeSection(title, cmp) {
  if (!cmp.current.length) return "<h3>" + title + "</h3>" + '<div class="empty">暂无数据</div>';
  const prev = new Map(cmp.previous.map(r => [r.alias, r]));
  // 同一 Profile 的两站挨在一起，组内按站点顺序；合计每个站点各一行
  const order = cmp.current.slice().sort((a, b) => {
    const ga = baseOf(a.alias), gb = baseOf(b.alias);
    return ga === gb ? siteRank(siteOf(a.alias)) - siteRank(siteOf(b.alias)) : ga.localeCompare(gb);
  });
  const rows = order.map(r => {
    const p = prev.get(r.alias) || { credited: 0, spent: null };
    const net = r.spent === null ? null : r.credited - r.spent;
    const pnet = p.spent === null ? null : (p.credited || 0) - p.spent;
    return ["<b>" + esc(baseOf(r.alias)) + "</b>", esc(siteName(siteOf(r.alias))),
            gain(r.credited), spentCell(r.spent), netCell(net),
            gain(p.credited || 0), spentCell(p.spent === undefined ? null : p.spent), netCell(pnet)];
  });
  const bySite = new Map();
  for (const r of cmp.current) {
    const site = siteOf(r.alias);
    const st = bySite.get(site) || { credited: 0, spent: 0, hasSpent: false };
    st.credited += r.credited || 0;
    if (r.spent !== null && r.spent !== undefined) { st.spent += r.spent; st.hasSpent = true; }
    bySite.set(site, st);
  }
  for (const site of [...bySite.keys()].sort((a, b) => siteRank(a) - siteRank(b))) {
    const st = bySite.get(site);
    const spent = st.hasSpent ? st.spent : null;
    rows.push(["<b>合计</b>", esc(siteName(site)), gain(st.credited), spentCell(spent),
               netCell(spent === null ? null : st.credited - spent), "", "", ""]);
  }
  return "<h3>" + title + "</h3>" + table([
    ["账号", "站点", "本期到账", "本期消耗", "本期净额", "上期到账", "上期消耗", "上期净额"], ...rows,
  ]);
}

function table(rows, footer) {
  const head = rows[0].map(h => "<th>" + h + "</th>").join("");
  const body = rows.slice(1).map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("");
  // 合计行渲染在末尾：它跨所有账号汇总，放在中间会被当成又一个账号。
  const foot = (footer || []).map(r => '<tr class="total">' + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("");
  return "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + foot + "</tbody></table>";
}

function drawChart(series) {
  const data = series.filter(s => s.points.length > 0);
  if (!data.length) return '<div class="empty">暂无余额数据</div>';
  // 按站点分图：两站余额差一个数量级（router-A 的余额远低于 router-B），
  // 共用一根 Y 轴会把低值那组压成一条直线，看不出趋势。
  const bySite = new Map();
  for (const s of data) {
    const site = siteOf(s.alias);
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(s);
  }
  const sites = [...bySite.keys()].sort((a, b) => siteRank(a) - siteRank(b));
  return sites.map(site => {
    const group = bySite.get(site);
    const panel = drawChartPanel(group);
    return sites.length > 1
      ? '<h3>' + esc(siteName(site)) + ' · ' + group.length + ' 个账号</h3>' + panel
      : panel;
  }).join("");
}

function drawChartPanel(data) {
  const W = 1000, H = 280, PAD = 44;
  const all = data.flatMap(s => s.points.map(p => p.balance));
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const times = data.flatMap(s => s.points.map(p => +new Date(p.time)));
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const x = t => t1 === t0 ? PAD : PAD + (t - t0) / (t1 - t0) * (W - PAD * 2);
  const y = v => H - PAD - (v - min) / (max - min) * (H - PAD * 2);

  const grid = [0, .25, .5, .75, 1].map(f => {
    const v = min + (max - min) * f, yy = y(v);
    return '<line x1="' + PAD + '" y1="' + yy + '" x2="' + (W - PAD) + '" y2="' + yy +
           '" stroke="#252a34"/><text x="6" y="' + (yy + 4) + '" fill="#98a0b3" font-size="11">$' +
           v.toFixed(0) + '</text>';
  }).join("");

  const paths = data.map((s, i) => {
    const c = COLORS[i % COLORS.length];
    const d = s.points.map((p, j) =>
      (j ? "L" : "M") + x(+new Date(p.time)).toFixed(1) + " " + y(p.balance).toFixed(1)).join(" ");
    const dots = s.points.map(p =>
      '<circle cx="' + x(+new Date(p.time)).toFixed(1) + '" cy="' + y(p.balance).toFixed(1) +
      '" r="2.5" fill="' + c + '"/>').join("");
    return '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="2"/>' + dots;
  }).join("");

  const axis = '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) +
               '" stroke="#252a34"/>' +
               '<text x="' + PAD + '" y="' + (H - 14) + '" fill="#98a0b3" font-size="11">' +
               new Date(t0).toLocaleString("zh-CN",{hour12:false}) + '</text>' +
               '<text x="' + (W - PAD) + '" y="' + (H - 14) + '" fill="#98a0b3" font-size="11" text-anchor="end">' +
               new Date(t1).toLocaleString("zh-CN",{hour12:false}) + '</text>';

  const legend = '<div class="legend">' + data.map((s, i) =>
    '<span><span class="dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
    esc(baseOf(s.alias)) + '</span>').join("") + '</div>';

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px">' +
         grid + axis + paths + '</svg>' + legend;
}

load().catch(e => { document.getElementById("meta").textContent = "加载失败：" + e.message; });
</script>
</body>
</html>`;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 本地时间的周区间；周一为一周起点，offset=0 是本周（到此刻为止），1 是上周。 */
function weekRange(offset: number): { start: string; end: string } {
  const today = startOfDay(new Date());
  const mondayOffset = (today.getDay() + 6) % 7;
  const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset);
  const start = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - offset * 7);
  const end = offset === 0
    ? new Date()
    : new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - (offset - 1) * 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** 本地时间的月区间；offset=0 是本月（到此刻为止），1 是上月。 */
function monthRange(offset: number): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const end = offset === 0 ? now : new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export type RangeComparison = {
  label: string;
  current: ReturnType<typeof rangeSummary>;
  previous: ReturnType<typeof rangeSummary>;
};

/** 周/月对比数据：本期与上一期的到账、消耗（消耗来自站点累计消耗的增量）。 */
export function rangeReport(dbFile?: string): { week: RangeComparison; month: RangeComparison } {
  const pick = (range: { start: string; end: string }) => rangeSummary(range.start, range.end, dbFile);
  const week = weekRange(0), lastWeek = weekRange(1);
  const month = monthRange(0), lastMonth = monthRange(1);
  return {
    week: { label: "本周 vs 上周", current: pick(week), previous: pick(lastWeek) },
    month: { label: "本月 vs 上月", current: pick(month), previous: pick(lastMonth) },
  };
}

/**
 * 配置里已绑定的账号。报表用它来回答"账号数到底应该是多少"——账本只有观测点才产生
 * 记录，新绑的账号如果跑之前没签到也没快照，就不会出现在账本里，但它是真实存在的账号。
 */
async function boundAccounts(home?: string): Promise<{ ok: boolean; accounts: { alias: string; identity: string }[] }> {
  if (!home) return { ok: false, accounts: [] };
  try {
    const store = await readStore(home);
    return {
      ok: true,
      accounts: store.accounts.map((account) => ({ alias: account.alias, identity: account.expectedIdentity })),
    };
  } catch {
    return { ok: false, accounts: [] };
  }
}

function handle(req: IncomingMessage, res: ServerResponse, dbFile?: string, home?: string): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (url.pathname === "/api/summary") return json(res, 200, summarizeAccounts(dbFile));
    if (url.pathname === "/api/accounts") {
      boundAccounts(home).then((value) => json(res, 200, value), (error: unknown) => json(res, 500, { error: String(error) }));
      return;
    }
    if (url.pathname === "/api/ranges") return json(res, 200, rangeReport(dbFile));
    if (url.pathname === "/api/daily") return json(res, 200, dailyTotals({}, dbFile));
    if (url.pathname === "/api/series") return json(res, 200, balanceSeries(dbFile));
    if (url.pathname === "/api/checkins") {
      const alias = url.searchParams.get("alias") ?? undefined;
      const raw = Number(url.searchParams.get("limit") ?? 500);
      return json(res, 200, listCheckins({ alias, limit: Number.isFinite(raw) ? raw : 500 }, dbFile));
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "internal error" });
  }
}

/** 启动报表服务器。返回 server 实例，便于调用方关闭。 */
export function startReportServer(options: ReportOptions = {}): Promise<Server> {
  const port = options.port ?? 8787;
  const server = createServer((req, res) => handle(req, res, options.dbFile, options.home));
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      options.onError?.(error);
      reject(error);
    });
    // 仅监听回环地址，不对外暴露。
    server.listen(port, "127.0.0.1", () => {
      options.onStart?.(`http://127.0.0.1:${port}/`);
      resolve(server);
    });
  });
}
