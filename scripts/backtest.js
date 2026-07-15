#!/usr/bin/env node
/**
 * 禁买清单有效性回测（升级版：价格信号跨2年，主力信号近6月）
 * Usage: node backtest.js [forwardDays]   默认3
 *
 * 价格类禁买(追高>5% / 放量破位大阴线): K线 lmt=500 ≈ 2年，跨多种行情
 * 主力净流出: fflow daykline lmt=120 ≈ 6个月（接口上限）
 *
 * ⚠️ 仍无法回测主观买点与你的执行纪律；仅测可机械化的禁买条件。
 */
const fs = require('fs');
const path = require('path');
const fwd = parseInt(process.argv[2] || '3');
const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;

async function getStock(s) {
  const kurl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${s.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=500`;
  const furl = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${s.secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=120&klt=101`;
  const [k, f] = await Promise.all([fetch(kurl).then(r => r.json()), fetch(furl).then(r => r.json())]);
  const kl = ((k.data && k.data.klines) || []).map(L => { const p = L.split(','); return { date: p[0], o: +p[1], c: +p[2], v: +p[5] }; });
  const fm = {};
  ((f.data && f.data.klines) || []).forEach(L => { const p = L.split(','); fm[p[0]] = +p[1] / 1e8; });
  return { kl, fm };
}

const summ = (arr) => {
  if (!arr.length) return 'n=0';
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  const win = arr.filter(x => x > 0).length / arr.length * 100;
  return `n=${arr.length}  平均 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%  胜率 ${win.toFixed(0)}%`;
};
const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

(async () => {
  const data = await Promise.all(wl.map(getStock));
  const B = { priceBan: [], priceClean: [], chase: [], breakdown: [], outflow: [], inflow: [] };
  let days = 0;
  for (const d of data) {
    const { kl, fm } = d;
    for (let i = 10; i < kl.length - fwd; i++) {
      const day = kl[i];
      const prevC = kl[i - 1].c;
      const ma10 = kl.slice(i - 9, i + 1).reduce((a, b) => a + b.c, 0) / 10;
      const volAvg5 = kl.slice(i - 5, i).reduce((a, b) => a + b.v, 0) / 5;
      const pct = (day.c - prevC) / prevC * 100;
      const mainFlow = fm[day.date];
      const fwdRet = (kl[i + fwd].c - day.c) / day.c * 100;
      days++;

      const chase = pct > 5;
      const breakdown = day.c < day.o && pct < -4 && day.v > volAvg5 * 1.1 && day.c < ma10;
      (chase || breakdown ? B.priceBan : B.priceClean).push(fwdRet);
      if (chase) B.chase.push(fwdRet);
      if (breakdown) B.breakdown.push(fwdRet);
      if (mainFlow !== undefined) (mainFlow < 0 ? B.outflow : B.inflow).push(fwdRet);
    }
  }
  console.log(`=== 禁买清单回测（持有${fwd}日收益）| 总样本 ${days} 股·日 ===\n`);
  console.log(`【价格类禁买，跨~2年多种行情】`);
  console.log(`  🔴 价格被禁日(追高/破位): ${summ(B.priceBan)}`);
  console.log(`  ✅ 价格全绿日:            ${summ(B.priceClean)}`);
  console.log(`  差值(全绿−被禁) = ${(avg(B.priceClean) - avg(B.priceBan)).toFixed(2)}% → ${avg(B.priceClean) - avg(B.priceBan) > 0 ? '✅ 有区分度' : '🔴 无/反向'}`);
  console.log(`    · 追高>5%日:      ${summ(B.chase)}`);
  console.log(`    · 放量破位大阴线日: ${summ(B.breakdown)}`);
  console.log(`\n【主力类禁买，近~6个月】`);
  console.log(`  🔴 主力净流出日: ${summ(B.outflow)}`);
  console.log(`  ✅ 主力净流入日: ${summ(B.inflow)}`);
  console.log(`  差值(流入−流出) = ${(avg(B.inflow) - avg(B.outflow)).toFixed(2)}% → ${avg(B.inflow) - avg(B.outflow) > 0 ? '✅ 有区分度' : '🔴 无/反向'}`);
})();
