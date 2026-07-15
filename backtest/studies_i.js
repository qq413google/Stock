#!/usr/bin/env node
/**
 * 研究I: Override入场 vs 干净入场 —— T+1隔夜风险对比
 * 运行: node studies_i.js
 * 输出: 控制台报告 + backtest/results_i.json
 *
 * 核心问题: 主力净流出但超大单>=0.5亿的"可信任override"入场信号，T+1尾部风险是否显著高于
 * 主力当日净流入的"干净入场"信号？以及0~0.5亿的"弱override"是否更不可信？
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

// ---------- 策略定义 (与 studies.js 保持一致，便于对照) ----------
function gate(r, i) {
  const c = r[i];
  if (!(c.c > c.ma60)) return false;     // 须站MA60
  if (!(c.c > c.ma20)) return false;     // 须站MA20
  if (i > 0 && (c.c / r[i - 1].c - 1) > 0.05) return false; // 当日涨>5%禁
  return true;
}
function banned(r, i) {
  const c = r[i];
  if (c.c < c.ma20 && (i > 0 && (c.c / r[i - 1].c - 1) < -0.03)) return '破位大阴线';
  for (let k = Math.max(0, i - 5); k <= i; k++) {
    const w = Math.max(...r.slice(Math.max(0, k - 20), k + 1).map(x => x.c));
    if (r[k].c >= w && c.c < c.ma20) return '顶部首跌';
  }
  if (c.c < c.ma60) return '板块退潮/逆势';
  return null;
}
function buyPoints(r, i) {
  if (i < 1) return null;
  const c = r[i];
  if (Math.abs(c.c - c.ma10) / c.ma10 < 0.02 && c.c >= c.ma10 && r[i - 1].c >= r[i - 1].ma20) return '回踩';
  let newHigh = false;
  for (let k = Math.max(0, i - 5); k <= i; k++) {
    const w = Math.max(...r.slice(Math.max(0, k - 20), k + 1).map(x => x.c));
    if (r[k].c >= w) newHigh = true;
  }
  if (newHigh && c.c <= c.ma20 * 1.03 && c.c > c.ma20) return '突破回踩';
  if (i > 0 && c.c > c.ma20 && r[i - 1].c <= r[i - 1].ma20 && c.mainRatio >= 10 && c.volRatio < 1.0) return '反包';
  return null;
}
function strictBuy(r, i) {
  if (!gate(r, i)) return null;
  if (banned(r, i)) return null;
  const kind = buyPoints(r, i);
  if (!kind) return null;
  const c = r[i];
  let stop = Math.min(c.ma20, c.c * 0.97);
  const stopDist = (c.c - stop) / c.c;
  if (stopDist > 0.04) return null;
  return { kind, stop, entry: c.c };
}

// ---------- 分类器 ----------
function classifySignal(r, i) {
  const c = r[i];
  if (isNaN(c.main) || isNaN(c.superL)) return null;
  if (c.main > 0) return 'clean'; // 干净入场：主力当日净流入
  if (c.superL >= 0.5) return 'override_trusted'; // 可信任override(v2.4阈值)
  if (c.superL >= 0) return 'override_weak'; // 0~0.5亿弱override
  return null; // main<0 且 superL<0: 直接FAIL,不在本研究范围
}

// ---------- 统计工具 ----------
function bucketStats(arr) {
  const n = arr.length;
  if (!n) return { n: 0, mean1: NaN, mean3: NaN, mean5: NaN, down1: NaN, down2pct: NaN, down4pct: NaN };
  const mean = k => arr.reduce((a, b) => a + b[k], 0) / n;
  const down = k => arr.filter(x => x[k] < 0).length / n;
  const exceed = (k, thr) => arr.filter(x => x[k] < -thr).length / n;
  return {
    n,
    mean1: mean('r1'),
    mean3: mean('r3'),
    mean5: mean('r5'),
    down1: down('r1'),
    down2pct: exceed('r1', 0.02),
    down4pct: exceed('r1', 0.04),
    min1: Math.min(...arr.map(x => x.r1)),
    max1: Math.max(...arr.map(x => x.r1))
  };
}
function fmtPct(x) { return (isNaN(x) ? 'N/A' : (x * 100).toFixed(2) + '%'); }

// ---------- 折扣版组合模拟 (不改lib.js,独立实现,只用于加分项) ----------
function simulatePortfolioDiscount(stocks, buyFn, discountFn, opts = {}) {
  const MAX_CONCURRENT = opts.maxConcurrent || 3;
  const MAX_HOLD = opts.maxHold || 60;
  const USE_CAP = opts.useCap !== false;
  const allDates = new Set();
  for (const s of stocks) for (const r of s.rows) allDates.add(r.date);
  const dates = Array.from(allDates).sort();
  const stockMaps = stocks.map(s => ({ name: s.name, rows: s.rows, map: new Map(s.rows.map((r, i) => [r.date, i])) }));
  const heldSet = new Set();
  let openPositions = [];
  const trades = [];
  let missedByCapacity = 0;
  let peakConcurrent = 0;

  for (const date of dates) {
    const surviving = [];
    const exitedToday = new Set();
    for (const pos of openPositions) {
      const sm = stockMaps.find(s => s.name === pos.stock);
      if (!sm) { surviving.push(pos); continue; }
      const idx = sm.map.get(date);
      if (idx === undefined) { surviving.push(pos); continue; }
      const r = sm.rows[idx];
      const profitPct = (r.c - pos.entry) / pos.entry;
      let effectiveStop = pos.stop;
      if (profitPct >= 0.05) effectiveStop = Math.max(effectiveStop, pos.entry);
      if (profitPct >= 0.05) effectiveStop = Math.max(effectiveStop, pos.highest * 0.93);
      pos.highest = Math.max(pos.highest, r.c);
      let exit = null, reason = '';
      if (pos.takeProfit && r.c >= pos.takeProfit) { exit = pos.takeProfit; reason = 'target'; }
      else if (r.l <= effectiveStop) { exit = effectiveStop; reason = 'stop'; }
      else if (r.c <= pos.entry * L.HARD_STOP) { exit = pos.entry * L.HARD_STOP; reason = 'hardstop'; }
      else if (profitPct >= 0.05 && r.c <= effectiveStop) { exit = effectiveStop; reason = 'trail'; }
      else if (idx - pos.entryIdx >= MAX_HOLD) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const cost = L.applyCost(pos.entry, exit, pos.shares);
        const pnl = (exit - pos.entry) * pos.shares - cost;
        const pnlPct = pnl / (pos.entry * pos.shares);
        trades.push({ stock: pos.stock, entryDate: pos.entryDate, exitDate: date, entry: pos.entry, exit, shares: pos.shares, pnl, pnlPct, kind: pos.kind, reason, cost });
        heldSet.delete(pos.stock);
        exitedToday.add(pos.stock);
      } else { surviving.push(pos); }
    }
    openPositions = surviving;
    peakConcurrent = Math.max(peakConcurrent, openPositions.length);

    const candidates = [];
    for (const sm of stockMaps) {
      if (heldSet.has(sm.name)) continue;
      if (exitedToday.has(sm.name)) continue;
      const idx = sm.map.get(date);
      if (idx === undefined) continue;
      const sig = buyFn(sm.rows, idx);
      if (!sig) continue;
      if (USE_CAP && sig.entry > L.PRICE_CAP) continue;
      candidates.push({ sm, idx, sig });
    }
    for (const { sm, idx, sig } of candidates) {
      if (openPositions.length >= MAX_CONCURRENT) { missedByCapacity++; continue; }
      let stop = sig.stop;
      if (!(stop > 0) || stop >= sig.entry) continue;
      stop = Math.max(stop, sig.entry * L.HARD_STOP);
      const stopDist = sig.entry - stop;
      if (stopDist <= 0) continue;
      let shares;
      if (sig.entry <= L.PRICE_CAP) {
        shares = Math.floor(L.RISK_YUAN / stopDist);
        shares = Math.min(shares, Math.floor(18000 / sig.entry));
      } else {
        shares = 100;
      }
      // 应用折扣
      const discount = discountFn(sm.rows, idx, sig);
      shares = Math.floor(shares * discount / 100) * 100; // 按百股取整
      if (shares < 100) continue;
      openPositions.push({ stock: sm.name, entry: sig.entry, stop, shares, kind: sig.kind,
        highest: sig.entry, takeProfit: sig.takeProfit || null, entryDate: date, entryIdx: idx });
      heldSet.add(sm.name);
    }
  }

  for (const pos of openPositions) {
    const sm = stockMaps.find(s => s.name === pos.stock);
    if (!sm) continue;
    const r = sm.rows[sm.rows.length - 1];
    const cost = L.applyCost(pos.entry, r.c, pos.shares);
    const pnl = (r.c - pos.entry) * pos.shares - cost;
    const pnlPct = pnl / (pos.entry * pos.shares);
    trades.push({ stock: pos.stock, entryDate: pos.entryDate, exitDate: r.date, entry: pos.entry, exit: r.c, shares: pos.shares, pnl, pnlPct, kind: pos.kind, reason: 'window_end', cost });
  }
  return { trades, missedByCapacity, peakConcurrent };
}

// ---------- 主程序 ----------
(async () => {
  const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;

  console.log('加载缓存...');
  const stocks = [];
  for (const s of wl) {
    const rows = await L.loadStock(s.secid, { klineLmt: 600, flowLmt: 120, clipToFlow: true });
    if (rows && rows.length > 60) stocks.push({ name: s.name, secid: s.secid, rows });
  }
  console.log(`  加载完成: ${stocks.length}/${wl.length} 只`);

  // 收集所有信号
  const buckets = { clean: [], override_trusted: [], override_weak: [] };
  for (const s of stocks) {
    for (let i = 1; i < s.rows.length - 5; i++) {
      const sig = strictBuy(s.rows, i);
      if (!sig) continue;
      const cls = classifySignal(s.rows, i);
      if (!cls) continue;
      const r1 = L.fwdReturn(s.rows, i, 1);
      const r3 = L.fwdReturn(s.rows, i, 3);
      const r5 = L.fwdReturn(s.rows, i, 5);
      if (r1 === null || r3 === null || r5 === null) continue;
      buckets[cls].push({ stock: s.name, date: s.rows[i].date, r1, r3, r5, kind: sig.kind, superL: s.rows[i].superL, main: s.rows[i].main });
    }
  }

  const results = {
    meta: {
      stockCount: stocks.length,
      totalSignals: Object.values(buckets).reduce((a, b) => a + b.length, 0),
      windowStart: stocks.length ? stocks[0].rows[0].date : null,
      windowEnd: stocks.length ? stocks[0].rows[stocks[0].rows.length - 1].date : null,
    },
    fwdReturn: {},
  };

  console.log('\n========== 研究I: Override入场 vs 干净入场 T+1风险对比 ==========');
  console.log('分组定义:');
  console.log('  clean:          strictBuy成立 + 当日主力净流入(main>0)');
  console.log('  override_trusted: strictBuy成立 + 当日主力净流出 + 超大单>=0.5亿(v2.4阈值)');
  console.log('  override_weak:  strictBuy成立 + 当日主力净流出 + 0<=超大单<0.5亿');
  console.log('');
  console.log('分组 | n | 1日均值 | 3日均值 | 5日均值 | 1日下跌率 | 1日跌幅>2% | 1日跌幅>4% | 1日最小 | 1日最大');

  for (const key of ['clean', 'override_trusted', 'override_weak']) {
    const stats = bucketStats(buckets[key]);
    results.fwdReturn[key] = stats;
    console.log(
      `${key.padEnd(18)} | ${stats.n.toString().padStart(3)} | ` +
      `${fmtPct(stats.mean1).padStart(8)} | ${fmtPct(stats.mean3).padStart(8)} | ${fmtPct(stats.mean5).padStart(8)} | ` +
      `${fmtPct(stats.down1).padStart(9)} | ${fmtPct(stats.down2pct).padStart(11)} | ${fmtPct(stats.down4pct).padStart(11)} | ` +
      `${fmtPct(stats.min1).padStart(8)} | ${fmtPct(stats.max1).padStart(8)}`
    );
  }

  // 两组差异
  const d = results.fwdReturn;
  console.log('');
  console.log('差异(override_trusted - clean):');
  console.log(`  1日均值差: ${fmtPct(d.override_trusted.mean1 - d.clean.mean1)}`);
  console.log(`  5日均值差: ${fmtPct(d.override_trusted.mean5 - d.clean.mean5)}`);
  console.log(`  1日下跌率高: ${fmtPct(d.override_trusted.down1 - d.clean.down1)}`);
  console.log(`  1日跌幅>2% 高: ${fmtPct(d.override_trusted.down2pct - d.clean.down2pct)}`);
  console.log(`  1日跌幅>4% 高: ${fmtPct(d.override_trusted.down4pct - d.clean.down4pct)}`);
  console.log('');
  console.log('差异(override_weak - clean):');
  console.log(`  1日均值差: ${fmtPct(d.override_weak.mean1 - d.clean.mean1)}`);
  console.log(`  5日均值差: ${fmtPct(d.override_weak.mean5 - d.clean.mean5)}`);
  console.log(`  1日下跌率高: ${fmtPct(d.override_weak.down1 - d.clean.down1)}`);
  console.log(`  1日跌幅>2% 高: ${fmtPct(d.override_weak.down2pct - d.clean.down2pct)}`);
  console.log(`  1日跌幅>4% 高: ${fmtPct(d.override_weak.down4pct - d.clean.down4pct)}`);

  // 算术自洽检查
  console.log('\n========== 算术自洽检查 ==========');
  for (const key of ['clean', 'override_trusted', 'override_weak']) {
    const arr = buckets[key];
    if (!arr.length) continue;
    const n = arr.length;
    const down1Count = arr.filter(x => x.r1 < 0).length;
    const down2Count = arr.filter(x => x.r1 < -0.02).length;
    const down4Count = arr.filter(x => x.r1 < -0.04).length;
    console.log(`${key}: n=${n}, down1=${down1Count}/${n}=${(down1Count/n).toFixed(4)} vs ${d[key].down1.toFixed(4)} ${Math.abs(down1Count/n - d[key].down1) < 0.001 ? '✅' : '🔴'}`);
    console.log(`      down2=${down2Count}/${n}=${(down2Count/n).toFixed(4)} vs ${d[key].down2pct.toFixed(4)} ${Math.abs(down2Count/n - d[key].down2pct) < 0.001 ? '✅' : '🔴'}`);
    console.log(`      down4=${down4Count}/${n}=${(down4Count/n).toFixed(4)} vs ${d[key].down4pct.toFixed(4)} ${Math.abs(down4Count/n - d[key].down4pct) < 0.001 ? '✅' : '🔴'}`);
  }

  // 加分项: 用 simulatePortfolio 看仓位折扣对组合的影响
  console.log('\n========== 加分项: Override仓位折扣对组合的影响 ==========');
  const discountResults = {};
  for (const discount of [1, 0.7, 0.5]) {
    const label = discount === 1 ? 'no_discount' : discount === 0.7 ? 'discount_70' : 'discount_50';
    const discountFn = (rows, idx, sig) => {
      const cls = classifySignal(rows, idx);
      return (cls === 'override_trusted' || cls === 'override_weak') ? discount : 1;
    };
    const res = simulatePortfolioDiscount(stocks, strictBuy, discountFn);
    const m = L.metrics(res.trades);
    discountResults[label] = { metrics: m, missed: res.missedByCapacity, peak: res.peakConcurrent };
    console.log(`${label}: n=${m.n} totalPnl=${m.totalPnl.toFixed(0)} exp=${m.exp.toFixed(0)} pf=${m.pf.toFixed(2)} mdd=${(m.mdd*100).toFixed(1)}% peak=${res.peakConcurrent}`);
  }
  results.discountSimulation = discountResults;

  // 结论建议
  console.log('\n========== 初步结论 ==========');
  const ot = d.override_trusted;
  const cl = d.clean;
  const ow = d.override_weak;
  if (ot.down4pct > cl.down4pct * 2 && ot.n >= 10) {
    console.log('🔴 override_trusted 1日跌幅>4%占比显著高于clean(超2倍), T+1下建议对override仓位打折(初步区间7折~5折)。');
  } else if (ot.down2pct > cl.down2pct * 1.5 && ot.n >= 10) {
    console.log('🟡 override_trusted 1日跌幅>2%占比明显更高, 可考虑轻度折扣(7折~8折)。');
  } else {
    console.log('✅ override_trusted 与 clean 尾部风险差异不大, T+1下无需因override身份额外打折。');
  }
  if (ow.down4pct > cl.down4pct * 1.5 && ow.n >= 10) {
    console.log('🔴 override_weak 尾部风险更高, 建议按v2.4维持FAIL,不入场。');
  }

  fs.writeFileSync(path.join(__dirname, 'results_i.json'), JSON.stringify(results, null, 2));
  console.log('\n✅ 结果已写入 backtest/results_i.json');
})();
