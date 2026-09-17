import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { balanceSeries, dailyTotals, listCheckins, rangeSummary, summarizeAccounts } from "./db.ts";

export type ReportOptions = {
  port?: number;
  dbFile?: string;
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
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:10px; overflow:hidden }
  th,td { padding:8px 12px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap }
  th { color:var(--dim); font-weight:600; font-size:12px; background:#12151b }
  tr:last-child td { border-bottom:none }
  .ok { color:var(--ok) } .bad { color:var(--bad) }
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
const COLORS = ["#58a6ff","#3fb950","#f0883e","#a371f7","#f85149","#39c5cf","#e3b341","#db61a2"];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money = v => v === null || v === undefined ? '<span class="muted">—</span>' : "$" + Number(v).toFixed(2);
const local = t => t ? new Date(t).toLocaleString("zh-CN", { hour12:false }) : '<span class="muted">—</span>';
const gain = v => v ? '<span class="gain">+$' + Number(v).toFixed(2) + '</span>' : '<span class="muted">$0.00</span>';
const spentCell = v => (v === null || v === undefined)
  ? '<span class="muted">—</span>' : '<span class="bad">-$' + Number(v).toFixed(2) + '</span>';
const netCell = v => (v === null || v === undefined) ? '<span class="muted">—</span>'
  : v >= 0 ? '<span class="gain">+$' + v.toFixed(2) + '</span>'
           : '<span class="bad">-$' + Math.abs(v).toFixed(2) + '</span>';

async function load() {
  const [sum, rows, series, ranges, daily] = await Promise.all([
    fetch("/api/summary").then(r => r.json()),
    fetch("/api/checkins?limit=500").then(r => r.json()),
    fetch("/api/series").then(r => r.json()),
    fetch("/api/ranges").then(r => r.json()),
    fetch("/api/daily").then(r => r.json()),
  ]);

  const accounts = sum.length;
  const totalRuns = sum.reduce((a, s) => a + s.total, 0);
  const totalCredited = sum.reduce((a, s) => a + s.credited, 0);
  const totalGain = sum.reduce((a, s) => a + s.totalGained, 0);
  document.getElementById("meta").textContent =
    accounts ? accounts + " 个账号 · 共 " + totalRuns + " 次打卡 · 数据为 UTC，显示已转本地时间"
             : "暂无数据";
  const latestDay = daily.length ? daily[daily.length - 1] : null;
  const totalBalance = latestDay && latestDay.balanceSum !== null ? latestDay.balanceSum : null;
  document.getElementById("cards").innerHTML = [
    ["账号数", accounts], ["打卡次数", totalRuns],
    ["成功到账", totalCredited], ["累计获得", "$" + totalGain.toFixed(2)],
    ["余额总额", totalBalance === null ? '<span class="muted">—</span>' : "$" + totalBalance.toFixed(2)],
    ["最近一日消耗", spentCell(latestDay ? latestDay.spentSum : null)],
  ].map(([k, v]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join("");

  document.getElementById("summary").innerHTML = accounts ? table([
    ["账号","身份","当前余额","累计到账","打卡次数","成功","成功率","最近打卡","最近结果"],
    ...sum.map(s => [
      "<b>" + esc(s.alias) + "</b>", esc(s.identity), money(s.currentBalance),
      s.totalGained ? '<span class="gain">+$' + s.totalGained.toFixed(2) + '</span>' : '<span class="muted">$0.00</span>',
      s.total, s.credited, (s.total ? Math.round(s.credited / s.total * 100) : 0) + "%",
      local(s.lastTime),
      s.lastOk === null ? "—" : s.lastOk
        ? '<span class="ok">成功</span>'
        : '<span class="bad">失败 ' + esc(s.lastErrorCode || "") + '</span>',
    ])
  ]) : '<div class="empty">还没有签到记录，先运行一次 <code>zenx accounts checkin</code> 吧。</div>';

  document.getElementById("daily").innerHTML = drawDaily(daily);

  document.getElementById("ranges").innerHTML = drawRanges(ranges);

  document.getElementById("chart").innerHTML = drawChart(series);

  document.getElementById("detail").innerHTML = rows.length ? table([
    ["时间","账号","打卡前","打卡后","增减","结果"],
    ...rows.map(r => {
      const delta = (r.balanceAfter !== null && r.balanceBefore !== null)
        ? r.balanceAfter - r.balanceBefore : null;
      return [
        local(r.time), esc(r.alias), money(r.balanceBefore), money(r.balanceAfter),
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
  const body = rows.slice().reverse().map(r => [
    "<b>" + esc(r.day) + "</b>",
    money(r.balanceSum),
    spentCell(r.spentSum),
    gain(r.creditedSum),
    (r.balanceAccounts || 0) + " 个余额 / " + (r.spentAccounts || 0) + " 个消耗",
  ]);
  return table([["日期", "余额总额", "当日消耗", "当日签到到账", "覆盖账号"], ...body]);
}

function drawRanges(ranges) {
  const note = '<div class="sub">到账 = 签到带来的余额增长；消耗 = 站点「历史消耗」的区间增量。' +
               '消耗需要每日观测点：每天跑一次 <code>zenx accounts snapshot --all</code>，' +
               '否则该区间显示「—」。</div>';
  return note + [["本周 vs 上周", ranges.week], ["本月 vs 上月", ranges.month]]
    .map(([title, cmp]) => rangeSection(title, cmp)).join("");
}

function rangeSection(title, cmp) {
  if (!cmp.current.length) return "<h3>" + title + "</h3>" + '<div class="empty">暂无数据</div>';
  const prev = new Map(cmp.previous.map(r => [r.alias, r]));
  const rows = cmp.current.map(r => {
    const p = prev.get(r.alias) || { credited: 0, spent: null };
    const net = r.spent === null ? null : r.credited - r.spent;
    const pnet = p.spent === null ? null : (p.credited || 0) - p.spent;
    return ["<b>" + esc(r.alias) + "</b>", gain(r.credited), spentCell(r.spent), netCell(net),
            gain(p.credited || 0), spentCell(p.spent === undefined ? null : p.spent), netCell(pnet)];
  });
  const credited = cmp.current.reduce((a, r) => a + (r.credited || 0), 0);
  const hasSpent = cmp.current.some(r => r.spent !== null);
  const spent = hasSpent ? cmp.current.reduce((a, r) => a + (r.spent || 0), 0) : null;
  rows.push(["<b>合计</b>", gain(credited), spentCell(spent), netCell(spent === null ? null : credited - spent), "", "", ""]);
  return "<h3>" + title + "</h3>" + table([
    ["账号", "本期到账", "本期消耗", "本期净额", "上期到账", "上期消耗", "上期净额"], ...rows,
  ]);
}

function table(rows) {
  const head = rows[0].map(h => "<th>" + h + "</th>").join("");
  const body = rows.slice(1).map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("");
  return "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
}

function drawChart(series) {
  const data = series.filter(s => s.points.length > 0);
  if (!data.length) return '<div class="empty">暂无余额数据</div>';
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
    esc(s.alias) + '</span>').join("") + '</div>';

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

function handle(req: IncomingMessage, res: ServerResponse, dbFile?: string): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (url.pathname === "/api/summary") return json(res, 200, summarizeAccounts(dbFile));
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
  const server = createServer((req, res) => handle(req, res, options.dbFile));
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
