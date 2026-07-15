#!/usr/bin/env node
/**
 * 回测"超跌反包"买点: 站回MA20(从下方上穿) + 当天主力/净占比 强度分组,
 * 看它抓的是"趋势反转(中兴型)"还是"失败反弹(刀)"——决定要不要建这个报警。
 *
 * 信号: 收盘上穿MA20 (cl[i]>MA20 且 cl[i-1]<=MA20[i-1]) —— 即"站回MA20"那天。
 * 出场: 跌破MA10 / -8% / 20日, 先到, 含费0.15%。
 * 分组关键: 站回当天 主力净额 / 净占比。若"站回+主力强流入"期望远好于"站回+流出"→ 过滤器有edge。
 *
 * ⚠️ fflow历史~120日、样本内、无滑点; directional 参考。
 * Usage: node backtest-reclaim.js
 */
const fs = require('fs');
const path = require('path');
const FEE = 0.15;
const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;

async function getJson(u) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(x => x.json()); if (r && r.data) return r; } catch (e) { }
    await new Promise(s => setTimeout(s, 400 * (i + 1)));
  }
  return null;
}
async function load(s) {
  const kUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${s.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=300`;
  const fUrl = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${s.secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=120&klt=101`;
  const [k, f] = await Promise.all([getJson(kUrl), getJson(fUrl)]);
  if (!k || !k.data || !k.data.klines) return null;
  const rows = k.data.klines.map(x => x.split(',')).map(p => ({ date: p[0], c: +p[2], h: +p[3], l: +p[4] }));
  const flow = {};
  if (f && f.data && f.data.klines) for (const L of f.data.klines) { const p = L.split(','); flow[p[0]] = { main: +p[1] / 1e8, ratio: +p[6] }; }
  return { rows, flow };
}
const ma = (r, i, n) => r.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n;

function scan(st, sink) {
  const { rows, flow } = st; const n = rows.length;
  for (let i = 60; i < n - 20; i++) {
    const date = rows[i].date;
    if (!(date in flow)) continue;
    const ma20 = ma(rows, i, 20), ma20p = ma(rows, i - 1, 20);
    const reclaim = rows[i].c > ma20 && rows[i - 1].c <= ma20p;   // 站回MA20
    if (!reclaim) continue;
    const entry = rows[i].c;
    let exit = null, j;
    for (j = i + 1; j < Math.min(i + 21, n); j++) {
      if (rows[j].l <= entry * 0.92) { exit = entry * 0.92; break; }
      if (rows[j].c < ma(rows, j, 10)) { exit = rows[j].c; break; }
    }
    if (exit === null) { j = Math.min(i + 20, n - 1); exit = rows[j].c; }
    sink.push({ main: flow[date].main, ratio: flow[date].ratio, strat: (exit - entry) / entry * 100 - FEE, fwd5: (rows[Math.min(i + 5, n - 1)].c - entry) / entry * 100, fwd10: (rows[Math.min(i + 10, n - 1)].c - entry) / entry * 100 });
  }
}
function stat(a, key) {
  if (!a.length) return `${key}: 0笔`;
  const r = a.map(x => x.strat), w = r.filter(x => x > 0), l = r.filter(x => x <= 0);
  const exp = r.reduce((x, y) => x + y, 0) / r.length;
  const aw = w.length ? w.reduce((x, y) => x + y, 0) / w.length : 0, al = l.length ? Math.abs(l.reduce((x, y) => x + y, 0) / l.length) : 0;
  const f5 = a.reduce((x, y) => x + y.fwd5, 0) / a.length, f10 = a.reduce((x, y) => x + y.fwd10, 0) / a.length;
  return `${key}: ${a.length}笔 胜率${(w.length / r.length * 100).toFixed(0)}% 盈亏比${al ? (aw / al).toFixed(2) : '∞'} 策略期望${exp >= 0 ? '+' : ''}${exp.toFixed(2)}% | fwd5${f5 >= 0 ? '+' : ''}${f5.toFixed(2)}% fwd10${f10 >= 0 ? '+' : ''}${f10.toFixed(2)}%`;
}

(async () => {
  const all = [];
  for (const s of wl) { const st = await load(s); if (st) scan(st, all); await new Promise(r => setTimeout(r, 200)); }
  console.log(`=== 超跌反包(站回MA20)回测 (${all.length}笔, ~120日窗口, 费0.15%) ===\n`);
  console.log(stat(all, '全部站回MA20(不过滤)'));
  console.log('--- 按站回当天主力 ---');
  console.log(stat(all.filter(x => x.main > 0), ' +主力净流入'));
  console.log(stat(all.filter(x => x.main <= 0), ' +主力净流出'));
  console.log('--- 按站回当天主力净占比(强度) ---');
  console.log(stat(all.filter(x => x.ratio >= 5), ' 净占比>=+5%(强)'));
  console.log(stat(all.filter(x => x.ratio >= 10), ' 净占比>=+10%(超强,中兴型)'));
  console.log(stat(all.filter(x => x.ratio < 0), ' 净占比<0(流出)'));
  console.log('\n⚠️ 样本内/无滑点/含暴跌窗口; 看"强流入"是否显著优于"不过滤/流出",才决定建不建这个报警。');
})();
