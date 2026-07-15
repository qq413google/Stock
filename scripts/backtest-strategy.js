#!/usr/bin/env node
/**
 * 完整策略回测：买点进场 + 规则化卖出 → 真实期望值
 * Usage: node backtest-strategy.js
 *
 * 进场(机械代理):
 *   突破买 = 收盘创20日新高 + 放量(>1.2倍5日均量) + 当日涨幅≤5%(不追高)
 *   回踩买 = 上升趋势(收>MA20) + 触MA10未破(低≤MA10*1.005 且 收>MA10) + 缩量(<5日均量)
 * 出场(策略真实卖出规则):
 *   -8%硬止损(盘中触及) 或 收盘跌破MA10(移动止盈) 或 持有满30日, 三者先到
 * 含往返手续费 0.15%。不重叠持仓。
 *
 * ⚠️ 买点是主观规则的机械近似；样本内、自选池、未含滑点。directional 参考。
 */
const fs = require('fs');
const path = require('path');
const FEE = 0.15;
const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;

async function getKline(s) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${s.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=500`;
  const k = await fetch(u).then(r => r.json());
  return { name: s.name, kl: ((k.data && k.data.klines) || []).map(L => { const p = L.split(','); return { o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] }; }) };
}
const ma = (kl, i, n) => kl.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n;
const volMa = (kl, i, n) => kl.slice(i - n, i).reduce((a, b) => a + b.v, 0) / n;

function runType(data, signalFn, filterFn) {
  const rets = [];
  for (const { kl } of data) {
    let i = 60;
    while (i < kl.length - 1) {
      if (!signalFn(kl, i) || (filterFn && !filterFn(kl, i))) { i++; continue; }
      const entry = kl[i].c;
      let exit = null, j;
      for (j = i + 1; j < Math.min(i + 31, kl.length); j++) {
        if (kl[j].l <= entry * 0.92) { exit = entry * 0.92; break; }      // -8% 硬止损
        if (kl[j].c < ma(kl, j, 10)) { exit = kl[j].c; break; }            // 跌破MA10 移动止盈
      }
      if (exit === null) { j = Math.min(i + 30, kl.length - 1); exit = kl[j].c; }
      rets.push((exit - entry) / entry * 100 - FEE);
      i = j + 1; // 不重叠
    }
  }
  return rets;
}
function report(name, rets) {
  if (!rets.length) { console.log(`${name}: 无交易`); return; }
  const wins = rets.filter(x => x > 0), losses = rets.filter(x => x <= 0);
  const avgW = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgL = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const exp = rets.reduce((a, b) => a + b, 0) / rets.length;
  console.log(`${name}: ${rets.length}笔 | 胜率${(wins.length / rets.length * 100).toFixed(0)}% | 均盈+${avgW.toFixed(2)}% 均亏-${avgL.toFixed(2)}% | 盈亏比${avgL ? (avgW / avgL).toFixed(2) : '∞'} | 每笔期望${exp >= 0 ? '+' : ''}${exp.toFixed(2)}% | 累计${rets.reduce((a, b) => a + b, 0).toFixed(0)}%`);
}

const breakout = (kl, i) => {
  const pct = (kl[i].c - kl[i - 1].c) / kl[i - 1].c * 100;
  const hi20 = Math.max(...kl.slice(i - 20, i).map(x => x.h));
  return kl[i].c > hi20 && kl[i].v > volMa(kl, i, 5) * 1.2 && pct <= 5 && pct > 0;
};
const pullback = (kl, i) => {
  return kl[i].c > ma(kl, i, 20) && kl[i].l <= ma(kl, i, 10) * 1.005 && kl[i].c > ma(kl, i, 10) && kl[i].v < volMa(kl, i, 5);
};

(async () => {
  const data = await Promise.all(wl.map(getKline));
  const trend = (kl, i) => kl[i].c > ma(kl, i, 60); // 长期上升趋势过滤
  console.log('=== 完整策略回测（买点进场 + 跌破MA10/-8%出场, 含费0.15%, ~2年）===\n');
  console.log('【无筛选】');
  report('  突破买', runType(data, breakout));
  report('  回踩买', runType(data, pullback));
  report('  合计  ', [...runType(data, breakout), ...runType(data, pullback)]);
  console.log('\n【加筛选: 仅在 收盘>MA60 长期上升趋势中买】');
  report('  突破买', runType(data, breakout, trend));
  report('  回踩买', runType(data, pullback, trend));
  report('  合计  ', [...runType(data, breakout, trend), ...runType(data, pullback, trend)]);
})();
