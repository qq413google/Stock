#!/usr/bin/env node
/**
 * 回测：「回踩买点成立」时，按当天主力/大单 流入vs流出 分组，看后续表现。
 * 回答：回踩到位但主力/大单流出的票，后续会不会涨？这条过滤器是帮忙还是错杀？
 *
 * 回踩买信号(与策略一致): 收>MA20 且 收>MA60 且 当日最低触及MA10(low<=MA10*1.005) 且 收>MA10
 * 分组: 当天主力净额 >0/<=0；当天大单净额 >0/<=0
 * 后续表现: ①fwd5/fwd10 收盘涨幅  ②策略出场(跌破MA10 或 -8% 或 20日, 含费0.15%)
 *
 * ⚠️ fflow历史仅~120交易日→样本小；单股尤甚；样本内、无滑点。directional 参考。
 * Usage: node backtest-flow.js [secid]   缺省=沪电0.002463; 传 all=全watchlist汇总
 */
const fs = require('fs');
const path = require('path');
const FEE = 0.15;
const arg = process.argv[2] || '0.002463';

async function getJson(u) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(u).then(x => x.json()); if (r && r.data) return r; } catch (e) { }
    await new Promise(r => setTimeout(r, 600));
  }
  return null;
}
async function load(secid) {
  const kUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=300`;
  const fUrl = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=120&klt=101`;
  const [k, f] = await Promise.all([getJson(kUrl), getJson(fUrl)]);
  if (!k || !k.data || !k.data.klines) return null;
  const rows = k.data.klines.map(s => s.split(','));
  const name = k.data.name || secid;
  const flow = {}; const flowArr = [];
  if (f && f.data && f.data.klines) {
    for (const L of f.data.klines) { const p = L.split(','); const o = { date: p[0], main: +p[1], big: +p[4], ratio: +p[6] }; flow[p[0]] = o; flowArr.push(o); } // p[4]=大单 p[6]=f57净占比
  }
  const flowIdx = {}; flowArr.forEach((o, i) => { flowIdx[o.date] = i; });
  return { name, rows, flow, flowArr, flowIdx };
}
const ma = (cl, i, n) => cl.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;

function scan(st, sink) {
  const { rows, flow, flowArr, flowIdx } = st;
  const cl = rows.map(r => +r[2]), hi = rows.map(r => +r[3]), lo = rows.map(r => +r[4]);
  const n = cl.length;
  const ema = (data, p) => { const k = 2 / (p + 1); const o = [data[0]]; for (let x = 1; x < data.length; x++) o.push(data[x] * k + o[x - 1] * (1 - k)); return o; };
  const e12 = ema(cl, 12), e26 = ema(cl, 26);
  const dif = cl.map((_, x) => e12[x] - e26[x]);
  const dea = ema(dif, 9);
  const chg = cl.map((c, x) => x ? c - cl[x - 1] : 0);
  const rsi = new Array(n).fill(null);
  for (let x = 14; x < n; x++) { let g = 0, l = 0; for (let k = x - 13; k <= x; k++) { if (chg[k] > 0) g += chg[k]; else l += -chg[k]; } const ag = g / 14, al = l / 14; rsi[x] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  for (let i = 60; i < n - 20; i++) {
    const date = rows[i][0];
    if (!(date in flow)) continue;                       // 只测有资金流数据的日子
    const m10 = ma(cl, i, 10), m20 = ma(cl, i, 20), m60 = ma(cl, i, 60);
    const signal = cl[i] > m20 && cl[i] > m60 && lo[i] <= m10 * 1.005 && cl[i] > m10; // 回踩MA10(顺势)
    if (!signal) continue;
    const entry = cl[i];
    const fwd5 = (cl[i + 5] - entry) / entry * 100;
    const fwd10 = (cl[i + 10] - entry) / entry * 100;
    // 策略出场
    let exit = null, j;
    for (j = i + 1; j < Math.min(i + 21, n); j++) {
      if (lo[j] <= entry * 0.92) { exit = entry * 0.92; break; }
      if (cl[j] < ma(cl, j, 10)) { exit = cl[j]; break; }
    }
    if (exit === null) { j = Math.min(i + 20, n - 1); exit = cl[j]; }
    const strat = (exit - entry) / entry * 100 - FEE;
    let sum5 = null, worst = null, dumpUnhealed = false;
    const jf = flowIdx[date];
    if (jf >= 4) {
      const win = flowArr.slice(jf - 4, jf + 1);
      sum5 = win.reduce((a, o) => a + o.main, 0) / 1e8;
      worst = Math.min(...win.map(o => o.ratio));
      dumpUnhealed = worst <= -8 && sum5 < 0;
    }
    sink.push({ main: flow[date].main, big: flow[date].big, fwd5, fwd10, strat, sum5, worst, dumpUnhealed, macdBull: dif[i] > dea[i], rsiVal: rsi[i] });
  }
}
function stat(arr, key) {
  if (!arr.length) return `${key}: 0笔`;
  const s = arr.filter(x => x.strat > 0);
  const w = s.length / arr.length * 100;
  const avgW = s.length ? s.reduce((a, b) => a + b.strat, 0) / s.length : 0;
  const ls = arr.filter(x => x.strat <= 0);
  const avgL = ls.length ? Math.abs(ls.reduce((a, b) => a + b.strat, 0) / ls.length) : 0;
  const exp = arr.reduce((a, b) => a + b.strat, 0) / arr.length;
  const f5 = arr.reduce((a, b) => a + b.fwd5, 0) / arr.length;
  const f10 = arr.reduce((a, b) => a + b.fwd10, 0) / arr.length;
  return `${key}: ${arr.length}笔 | 胜率${w.toFixed(0)}% 盈亏比${avgL ? (avgW / avgL).toFixed(2) : '∞'} 策略期望${exp >= 0 ? '+' : ''}${exp.toFixed(2)}% | fwd5均值${f5 >= 0 ? '+' : ''}${f5.toFixed(2)}% fwd10均值${f10 >= 0 ? '+' : ''}${f10.toFixed(2)}%`;
}
function report(label, all) {
  console.log(`\n=== ${label} (回踩买点 ${all.length}笔) ===`);
  console.log(stat(all, '全部'));
  console.log('--- 按当日主力净额 ---');
  console.log(stat(all.filter(x => x.main > 0), ' 主力净流入'));
  console.log(stat(all.filter(x => x.main <= 0), ' 主力净流出'));
  console.log('--- 按当日大单净额 ---');
  console.log(stat(all.filter(x => x.big > 0), ' 大单净流入'));
  console.log(stat(all.filter(x => x.big <= 0), ' 大单净流出'));
  console.log('--- 按信号日回看5日主力 ---');
  console.log(stat(all.filter(x => x.sum5 !== null && x.sum5 > 0), ' 5日净流入'));
  console.log(stat(all.filter(x => x.sum5 !== null && x.sum5 <= 0), ' 5日净流出'));
  console.log('--- 检验新规则「暴量派发未修复」(净占比<=-8% 且 5日净流出) ---');
  console.log(stat(all.filter(x => x.dumpUnhealed === true), ' 暴量派发未修复(新规则会拦)'));
  console.log(stat(all.filter(x => x.sum5 !== null && x.dumpUnhealed === false), ' 无此问题(放行)'));
  console.log('--- 检验 MACD状态 ---');
  console.log(stat(all.filter(x => x.macdBull === true), ' MACD多头(DIF>DEA)'));
  console.log(stat(all.filter(x => x.macdBull === false), ' MACD死叉(DIF<DEA)'));
  console.log('--- 检验 RSI ---');
  console.log(stat(all.filter(x => x.rsiVal !== null && x.rsiVal > 70), ' RSI超买(>70)'));
  console.log(stat(all.filter(x => x.rsiVal !== null && x.rsiVal <= 70), ' RSI正常(<=70)'));
}

(async () => {
  if (arg === 'all') {
    const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
    const all = [];
    for (const s of wl) {
      const st = await load(s.secid);
      if (st) scan(st, all);
      await new Promise(r => setTimeout(r, 200));
    }
    report(`全自选池汇总(${wl.length}只, fflow~120日窗口)`, all);
  } else {
    const st = await load(arg);
    if (!st) { console.log('数据拉取失败'); return; }
    const one = []; scan(st, one);
    report(st.name, one);
  }
})();
