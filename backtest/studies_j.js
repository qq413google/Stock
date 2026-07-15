/**
 * 研究J: 主力流出收窄信号 (日度版本, 盘中版本因无历史intraday快照无法回测)
 * 方法论同 D/E/H/G: fwdReturn 分桶对比, 不走 simulatePortfolio。
 * 问题: 昨天净流出、今天净流出但比昨天收窄(仍是负数, 只是没那么负), 是否预示后续更好表现？
 * 对照: 收窄组 vs 走阔/持平组 vs (研究G已测的)真正转正组
 */
const L = require('./lib.js');
const fs = require('fs');
const path = require('path');
const WL = require('../watchlist.json').stocks;

const fmtPct = n => (n === null || n === undefined || isNaN(n)) ? 'N/A' : (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const hit  = a => a.length ? a.filter(x => x < 0).length / a.length : NaN;

async function run() {
  console.log('从缓存加载自选股...');
  const all = await L.pool(WL, async s => {
    try { const rows = await L.loadStock(s.secid, { klineLmt: 600, flowLmt: 120, clipToFlow: true }); return { ...s, rows }; }
    catch (e) { return { ...s, rows: [], err: String(e) }; }
  }, 3);
  const stocks = all.filter(s => s.rows.length > 60);
  console.log(`加载完成: ${stocks.length}/${WL.length} 只有效\n`);

  console.log('========== 研究J: 主力流出收窄信号(日度版) ==========');
  console.log('场景: 昨天main<0 且 今天main<0(仍是流出) —— 今天比昨天收窄 vs 走阔/持平\n');

  const buckets = {
    narrow_big:  [], // 收窄>=50%(流出幅度砍掉一半以上)
    narrow_small:[], // 收窄0~50%
    widen:       [], // 走阔或持平(今天流出幅度>=昨天)
  };

  for (const s of stocks) {
    const r = s.rows;
    for (let i = 1; i < r.length; i++) {
      const today = r[i].main, yest = r[i - 1].main;
      if (isNaN(today) || isNaN(yest)) continue;
      if (!(yest < 0) || !(today < 0)) continue; // 两天都要是净流出

      const f1 = L.fwdReturn(r, i, 1), f3 = L.fwdReturn(r, i, 3), f5 = L.fwdReturn(r, i, 5);
      if (f5 == null) continue;

      const narrowRatio = (yest - today) / Math.abs(yest); // 正数=收窄, 负数=走阔
      const entry = { f1, f3, f5, today, yest, narrowRatio };

      if (narrowRatio >= 0.5) buckets.narrow_big.push(entry);
      else if (narrowRatio > 0) buckets.narrow_small.push(entry);
      else buckets.widen.push(entry);
    }
  }

  const rows = [
    { key: '收窄>=50%(流出砍半以上)', arr: buckets.narrow_big },
    { key: '收窄0~50%', arr: buckets.narrow_small },
    { key: '走阔/持平(今天流出>=昨天)', arr: buckets.widen },
  ];

  console.log('分组 | n | 1日均值 | 3日均值 | 5日均值 | 5日下跌率');
  for (const b of rows) {
    const a = b.arr;
    console.log(`${b.key}: n=${a.length}  1日=${fmtPct(mean(a.map(x=>x.f1)))}  3日=${fmtPct(mean(a.map(x=>x.f3)))}  5日=${fmtPct(mean(a.map(x=>x.f5)))}  下跌率=${fmtPct(hit(a.map(x=>x.f5)))}`);
  }

  const bigMean5 = mean(buckets.narrow_big.map(x=>x.f5));
  const smallMean5 = mean(buckets.narrow_small.map(x=>x.f5));
  const widenMean5 = mean(buckets.widen.map(x=>x.f5));
  console.log('');
  console.log(`收窄>=50%组 vs 走阔组: delta=${fmtPct(bigMean5 - widenMean5)}`);
  const verdict = (bigMean5 - widenMean5) > 0.01
    ? '收窄组明显好于走阔组 -> 流出收窄是有效的独立先行信号, 可作为软提醒(不是买入依据, 但值得优先关注)'
    : (bigMean5 - widenMean5) > 0
      ? '收窄组略好于走阔组, 差异不够显著 -> 可作弱参考'
      : '收窄组不比走阔组好 -> 流出收窄本身不预测反转, 是噪音, 不建议纳入判断';
  console.log(`结论: ${verdict}`);

  // 算术自洽检查
  console.log('\n========== 算术自洽检查 ==========');
  for (const b of rows) {
    const a = b.arr;
    if (!a.length) continue;
    const n = a.length;
    const down5Count = a.filter(x => x.f5 < 0).length;
    console.log(`${b.key}: n=${n}, down5=${down5Count}/${n}=${(down5Count/n).toFixed(4)} ${Math.abs(down5Count/n - hit(a.map(x=>x.f5))) < 0.001 ? '✅' : '🔴'}`);
  }

  const summary = {
    meta: { date: new Date().toISOString(), stockCount: stocks.length },
    narrow_big:  { n: buckets.narrow_big.length,  f1: mean(buckets.narrow_big.map(x=>x.f1)),  f3: mean(buckets.narrow_big.map(x=>x.f3)),  f5: mean(buckets.narrow_big.map(x=>x.f5)),  down5: hit(buckets.narrow_big.map(x=>x.f5)) },
    narrow_small:{ n: buckets.narrow_small.length,f1: mean(buckets.narrow_small.map(x=>x.f1)),f3: mean(buckets.narrow_small.map(x=>x.f3)),f5: mean(buckets.narrow_small.map(x=>x.f5)),down5: hit(buckets.narrow_small.map(x=>x.f5)) },
    widen:       { n: buckets.widen.length,       f1: mean(buckets.widen.map(x=>x.f1)),       f3: mean(buckets.widen.map(x=>x.f3)),       f5: mean(buckets.widen.map(x=>x.f5)),       down5: hit(buckets.widen.map(x=>x.f5)) },
  };
  fs.writeFileSync(path.join(__dirname, 'results_j.json'), JSON.stringify(summary, null, 2));
  console.log('\n✅ 结果已写入 backtest/results_j.json');
}
run();
