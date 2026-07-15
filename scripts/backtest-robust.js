#!/usr/bin/env node
/**
 * 稳健性回测：给"完整策略(顺势回踩/突破 + 跌破MA10/-8%出场)"做两项压力测试：
 *   ① 摩擦敏感性：往返成本 0.15% / 0.30% / 0.50%(含滑点)下，每笔期望还剩多少
 *   ② 样本外：把每只票的历史折半，前半段(train)与后半段(test)分别算期望——
 *      若只有前半段有 edge、后半段塌了 → 大概率过拟合/靠特定行情
 *
 * 策略 = 与 backtest-strategy.js 一致：突破买 + 回踩买，收>MA60 顺势过滤，
 *        出场 -8%硬止损 或 跌破MA10 或 30日，先到为准，不重叠持仓。
 *
 * ⚠️ 仍未建模：涨跌停无法成交(涨停买不进/跌停卖不掉)——所以真实成交还会更差一点。
 * Usage: node backtest-robust.js
 */
const fs = require('fs');
const path = require('path');
const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;

async function getKline(s) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${s.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=500`;
  for (let a = 0; a < 4; a++) {
    try { const k = await fetch(u).then(r => r.json()); const kl = ((k.data && k.data.klines) || []).map(L => { const p = L.split(','); return { o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] }; }); if (kl.length >= 120) return { name: s.name, kl }; } catch (e) { }
    await new Promise(r => setTimeout(r, 500));
  }
  return { name: s.name, kl: [] };
}
const ma = (kl, i, n) => kl.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n;
const volMa = (kl, i, n) => kl.slice(i - n, i).reduce((a, b) => a + b.v, 0) / n;
const breakout = (kl, i) => {
  const pct = (kl[i].c - kl[i - 1].c) / kl[i - 1].c * 100;
  const hi20 = Math.max(...kl.slice(i - 20, i).map(x => x.h));
  return kl[i].c > hi20 && kl[i].v > volMa(kl, i, 5) * 1.2 && pct <= 5 && pct > 0;
};
const pullback = (kl, i) => kl[i].c > ma(kl, i, 20) && kl[i].l <= ma(kl, i, 10) * 1.005 && kl[i].c > ma(kl, i, 10) && kl[i].v < volMa(kl, i, 5);
const trend = (kl, i) => kl[i].c > ma(kl, i, 60);

// 收集每笔交易的 rawRet(未扣费) 与 所属半段
function collect(data) {
  const trades = [];
  for (const { kl } of data) {
    if (kl.length < 120) continue;
    const mid = Math.floor(kl.length / 2);
    let i = 60;
    while (i < kl.length - 1) {
      if (!(breakout(kl, i) || pullback(kl, i)) || !trend(kl, i)) { i++; continue; }
      const entry = kl[i].c;
      let exit = null, j;
      for (j = i + 1; j < Math.min(i + 31, kl.length); j++) {
        if (kl[j].l <= entry * 0.92) { exit = entry * 0.92; break; }
        if (kl[j].c < ma(kl, j, 10)) { exit = kl[j].c; break; }
      }
      if (exit === null) { j = Math.min(i + 30, kl.length - 1); exit = kl[j].c; }
      trades.push({ raw: (exit - entry) / entry * 100, half: i < mid ? 1 : 2 });
      i = j + 1;
    }
  }
  return trades;
}
function summ(trades, fee) {
  if (!trades.length) return `0笔`;
  const rets = trades.map(t => t.raw - fee);
  const wins = rets.filter(x => x > 0);
  const exp = rets.reduce((a, b) => a + b, 0) / rets.length;
  const avgW = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const losses = rets.filter(x => x <= 0);
  const avgL = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  return `${rets.length}笔 胜率${(wins.length / rets.length * 100).toFixed(0)}% 盈亏比${avgL ? (avgW / avgL).toFixed(2) : '∞'} 每笔期望${exp >= 0 ? '+' : ''}${exp.toFixed(2)}% 累计${rets.reduce((a, b) => a + b, 0).toFixed(0)}%`;
}

(async () => {
  const data = [];
  for (const s of wl) { data.push(await getKline(s)); await new Promise(r => setTimeout(r, 150)); }
  const ok = data.filter(d => d.kl.length >= 120);
  const trades = collect(data);
  console.log(`=== 稳健性回测 (${ok.length}/${wl.length}只可用, 顺势回踩+突破, ~2年) ===\n`);
  console.log('① 摩擦敏感性(往返成本):');
  for (const fee of [0.15, 0.30, 0.50]) console.log(`   费${fee.toFixed(2)}%: ${summ(trades, fee)}`);
  console.log('\n② 样本外(每只票历史折半, 费按0.30%):');
  console.log(`   前半段(train): ${summ(trades.filter(t => t.half === 1), 0.30)}`);
  console.log(`   后半段(test) : ${summ(trades.filter(t => t.half === 2), 0.30)}`);
  console.log('\n⚠️ 未建模涨跌停无法成交,真实还会更差一点。');
})();
