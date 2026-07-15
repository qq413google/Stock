#!/usr/bin/env node
/**
 * 大盘环境客观分级
 * Usage: node market.js
 * 综合三大指数(涨跌幅 + 是否站上MA20)与板块普涨度，输出市场状态与建议总仓位上限。
 *
 * 注: 实时北向资金已停发、本环境全市场涨跌家数(clist限100条)不可得，
 *     故用「指数+MA20+板块」替代「北向/涨停家数」做市场分级。
 */
const indices = [
  { secid: '1.000001', name: '上证' },
  { secid: '0.399001', name: '深证' },
  { secid: '0.399006', name: '创业板' }
];
const ma = (a, p) => a.slice(-p).reduce((x, y) => x + y, 0) / p;

// push2his 并发易被远端断连(UND_ERR_SOCKET)，加 UA + 重试 + 顺序请求兜底
async function fetchRetry(u, n = 4) {
  let e;
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      return await r.json();
    } catch (err) { e = err; await new Promise(s => setTimeout(s, 300 * (i + 1))); }
  }
  throw e;
}

// Hurst(差分法, 100日): >0.5偏趋势 <0.5偏震荡/均值回归 =0.5随机。滞后指标,仅作软参考。
function hurst(x) {
  const lags = [], tau = [];
  for (let lag = 2; lag <= 20; lag++) { let s = 0, c = 0; for (let i = lag; i < x.length; i++) { const d = x[i] - x[i - lag]; s += d * d; c++; } if (c) { tau.push(Math.sqrt(s / c)); lags.push(lag); } }
  const lx = lags.map(Math.log), ly = tau.map(v => Math.log(v || 1e-9)), N = lx.length;
  const mx = lx.reduce((p, q) => p + q, 0) / N, my = ly.reduce((p, q) => p + q, 0) / N;
  let num = 0, den = 0; for (let i = 0; i < N; i++) { num += (lx[i] - mx) * (ly[i] - my); den += (lx[i] - mx) ** 2; }
  return den ? num / den : 0.5;
}
async function cyCloses() {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.399006&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=120`;
  const d = await fetchRetry(u);
  return d.data.klines.map(s => +s.split(',')[2]);
}

async function idx(o) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${o.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=25`;
  const d = await fetchRetry(u);
  const cl = d.data.klines.map(s => +s.split(',')[2]);
  const cur = cl[cl.length - 1], prev = cl[cl.length - 2];
  return { name: o.name, cur, pct: (cur - prev) / prev * 100, ma20: ma(cl, 20) };
}

async function sectors() {
  const u = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3&fields=f3,f14';
  const d = await fetchRetry(u);
  const a = d.data.diff;
  return { top: a[0], up: a.filter(x => x.f3 > 0).length, strong: a.filter(x => x.f3 >= 3).length, total: a.length };
}

(async () => {
  const ix = [];
  for (const o of indices) ix.push(await idx(o));
  const sec = await sectors();
  let hLine = '';
  try { const cc = await cyCloses(); if (cc.length >= 100) { const H = hurst(cc.slice(-100)); const tag = H >= 0.55 ? '偏趋势(强)' : H >= 0.5 ? '偏趋势' : H >= 0.45 ? '中性偏震荡' : '偏震荡'; hLine = `趋势记忆(创业板100日): H=${H.toFixed(2)} ${tag} [滞后·参考·非开关,转折必失灵]`; } } catch (e) { }
  const sh = ix[0];
  const avg = ix.reduce((s, x) => s + x.pct, 0) / ix.length;
  const shAboveMa = sh.cur >= sh.ma20;

  console.log('=== 大盘环境 ===');
  ix.forEach(x => console.log(`${x.name}: ${x.cur.toFixed(2)} ${x.pct >= 0 ? '+' : ''}${x.pct.toFixed(2)}% | MA20=${x.ma20.toFixed(2)} ${x.cur >= x.ma20 ? '上方✅' : '下方🔴'}`));
  console.log(`板块TOP10: ${sec.up}/${sec.total} 上涨, ${sec.strong} 只≥3% | 领涨 ${sec.top.f14} +${sec.top.f3}%`);

  let state, cap;
  if (avg <= -2) { state = '暴跌中 🔴'; cap = '0%(空仓)'; }
  else if (avg < -0.5 || (!shAboveMa && avg < 0)) { state = '弱势/调整 🟡'; cap = '≤20%'; }
  else if (shAboveMa && avg >= 0.8 && sec.up >= 6) { state = '强势上行 ✅'; cap = '≤50%'; }
  else { state = '震荡 🟡'; cap = '≤30%'; }
  console.log(`--- 市场状态: ${state} | 建议总仓位上限: ${cap} ---`);
  console.log(`(三指数均值 ${avg.toFixed(2)}% | 上证${shAboveMa ? '站上' : '跌破'}MA20 | 板块 ${sec.up} 涨)`);
  if (hLine) console.log(hLine);
})();
