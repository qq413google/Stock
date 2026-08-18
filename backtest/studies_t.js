#!/usr/bin/env node
/**
 * 研究T：止损距离该设多宽？(2026-08-18)
 *
 * 起因：京东方 8/14 止损@5.84 后，8/17 +4.6%、8/18 +4.11% 涨到 6.33，若持有至今 +351
 *       而非 -98（差约449元）。用户问"是不是卖错了"。
 *       复核发现：当日最低 5.71 已跌破原计划止损 5.76，**即使没有那个MA10 bug 也会被止损**
 *       （bug 实际代价仅约72元），所以问题不在 bug，而在**止损距离本身可能太紧**：
 *           成本5.94 → 止损5.76(-3.0%) → 当日最低5.71(-3.9%) → 4日后最高6.43(+8.2%)
 *       只多跌 0.9% 就被扫，随后走出 +8.2%。
 *
 * 而现行止损 `min(MA20, 价×0.97)` 里的 3% 是从买点定义里带出来的，**从未单独验证过**。
 * 它和加仓门槛(5%)、涨幅禁买(3%)一样是每笔必用的核心参数。
 *
 * ⚠️ 关键耦合（必须在回测里体现，否则结论无效）：
 *   仓位 = 750元风险 ÷ 止损距离  →  **止损越宽，仓位自动越小，单笔风险恒定**
 *   所以"宽止损"不等于"承担更大风险"，它换来的是"更少的股数 + 更强的抗噪能力"。
 *   lib.js 的 simulate 本来就是这个逻辑，本研究沿用。
 *
 * 问题：
 *   Q1 固定百分比止损，2%~8% 哪个最优？
 *   Q2 技术位止损(MA20) vs 固定百分比 vs 现行的 min(两者) ?
 *   Q3 ATR 自适应止损（按个股波动缩放）是否优于固定值？
 *   Q4 被止损扫出后 5 日内反弹的比例有多高？（量化"误杀率"）
 *
 * 口径与研究K/M/N/P/Q一致：纯价格进场、1200日、0.15%成本、-8%硬顶、≤180上限、
 * 移动止损用研究P的A方案(浮盈≥5%后 max(成本,峰值×0.93)，不含MA10)。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

// ATR(14) —— 按个股波动自适应的止损基准
function addATR(rows, n = 14) {
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) { rows[i].atr = rows[i].h - rows[i].l; continue; }
    const p = rows[i - 1].c;
    const tr = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - p), Math.abs(rows[i].l - p));
    rows[i].tr = tr;
    if (i < n) { rows[i].atr = rows.slice(1, i + 1).reduce((a, r) => a + (r.tr || 0), 0) / i; }
    else { rows[i].atr = rows.slice(i - n + 1, i + 1).reduce((a, r) => a + (r.tr || 0), 0) / n; }
  }
  return rows;
}

// 进场信号：与前几个研究逐字一致（不含止损，止损由 stopOf 决定）
function buySignal(rows, i) {
  if (i < 60) return null;
  const r = rows[i], p = rows[i - 1];
  if (!(r.ma60 > 0) || !(r.ma20 > 0)) return null;
  if (r.c > PRICE_CAP) return null;
  if ((r.c - p.c) / p.c > 0.05) return null;
  if (r.rsi > 70) return null;
  if (p.c <= p.ma20 && r.c > r.ma20) return { kind: 'rebound', entry: r.c };
  const bull = r.ma5 > r.ma10 && r.ma10 > r.ma20 && r.ma20 > r.ma60;
  if (bull && r.c > r.ma60 && r.c >= r.ma10 && Math.abs(r.c - r.ma10) / r.ma10 <= 0.02 && r.volRatio < 1.0) {
    return { kind: 'pullback', entry: r.c };
  }
  return null;
}

// 各种止损口径
function stopOf(r, mode) {
  const c = r.c;
  if (mode.startsWith('pct')) return c * (1 - parseFloat(mode.slice(3)) / 100);
  if (mode === 'ma20') return r.ma20;
  if (mode === 'cur') return Math.min(r.ma20, c * 0.97);          // 现行公式
  if (mode === 'curWide') return Math.min(r.ma20, c * 0.95);      // 现行放宽到5%
  if (mode.startsWith('atr')) return c - parseFloat(mode.slice(3)) * (r.atr || c * 0.03);
  return c * 0.97;
}

function simulate(rows, { mode = 'cur', maxHold = 60, name = '' } = {}) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos) {
      const profitPct = (r.c - pos.entry) / pos.entry;
      let stop = pos.stop;
      if (profitPct >= 0.05) { stop = Math.max(stop, pos.entry, pos.highest * 0.93); }
      pos.highest = Math.max(pos.highest, r.c);
      let exit = null, reason = '';
      if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= pos.entry * HARD_STOP) { exit = pos.entry * HARD_STOP; reason = 'hardstop'; }
      else if (i - pos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const pnl = (exit - pos.entry) * pos.shares - applyCost(pos.entry, exit, pos.shares);
        // 误杀统计：止损出场后 5 日内最高价，看是否反弹回买入价之上
        let rebound5 = null;
        if (reason === 'stop' || reason === 'hardstop') {
          const fwd = rows.slice(i + 1, i + 6);
          if (fwd.length) rebound5 = (Math.max(...fwd.map(x => x.h)) - exit) / exit;
        }
        trades.push({
          stock: name, entryDate: rows[pos.i].date, pnl, pnlPct: (exit - pos.entry) / pos.entry,
          reason, days: i - pos.i, shares: pos.shares, stopDist: pos.stopDist, rebound5,
          backAboveEntry: rebound5 !== null && Math.max(...rows.slice(i + 1, i + 6).map(x => x.h)) > pos.entry,
        });
        pos = null;
      }
      pos && (pos.stop = stop);
      continue;
    }
    const sig = buySignal(rows, i);
    if (!sig) continue;
    let stop = stopOf(r, mode);
    if (!(stop > 0) || stop >= sig.entry) continue;
    stop = Math.max(stop, sig.entry * HARD_STOP);          // -8%硬顶封底
    const dist = sig.entry - stop;
    if (dist <= 0) continue;
    // ⚠️ 关键：仓位由止损距离反推 —— 止损越宽，股数越少，单笔风险恒定750元
    let shares = Math.floor(RISK_YUAN / dist);
    shares = Math.min(shares, Math.floor(18000 / sig.entry));
    shares = Math.max(shares - (shares % 100), 100);
    if (shares < 100) continue;
    pos = { i, entry: sig.entry, shares, stop, kind: sig.kind, highest: sig.entry, stopDist: dist / sig.entry };
  }
  return trades;
}

const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  console.log('=== 研究T：止损距离该设多宽 ===\n');
  const loaded = await pool(wl, async s => {
    try {
      const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false });
      return rows.length > 120 ? { name: s.name, rows: addATR(rows) } : null;
    } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 仓位=750÷止损距离(宽止损自动减仓,单笔风险恒定)\n`);

  const run = m => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { mode: m, name: s.name })); return a; };
  const out = {};
  const MODES = [
    ['pct2', '固定 2%'], ['pct3', '固定 3%'], ['pct4', '固定 4%'], ['pct5', '固定 5%'],
    ['pct6', '固定 6%'], ['pct8', '固定 8%'],
    ['ma20', 'MA20技术位'], ['cur', '现行 min(MA20, 价×0.97)'], ['curWide', 'min(MA20, 价×0.95)'],
    ['atr1.5', 'ATR×1.5'], ['atr2', 'ATR×2'], ['atr3', 'ATR×3'],
  ];

  console.log('########## Q1/Q2/Q3 各止损口径对比 ##########');
  console.log('口径'.padEnd(24) + '笔数  胜率  每笔    pf    回撤    总盈亏    均止损距  均持有');
  const res = {};
  for (const [m, label] of MODES) {
    const all = run(m);
    const mt = metrics(all);
    const avgDist = all.reduce((a, t) => a + t.stopDist, 0) / all.length;
    const avgDays = all.reduce((a, t) => a + t.days, 0) / all.length;
    res[m] = { all, mt };
    out[m] = { label, n: mt.n, winRate: mt.winRate, exp: mt.exp, pf: mt.pf, mdd: mt.mdd, total: mt.totalPnl, avgDist, avgDays };
    console.log(
      label.padEnd(24) +
      String(mt.n).padStart(4) + '  ' + pct(mt.winRate).padStart(4) + '  ' +
      String(mt.exp.toFixed(0)).padStart(5) + '  ' + mt.pf.toFixed(2) + '  ' +
      (mt.mdd * 100).toFixed(1).padStart(5) + '%  ' + String(mt.totalPnl.toFixed(0)).padStart(8) + '  ' +
      (avgDist * 100).toFixed(1).padStart(6) + '%  ' + avgDays.toFixed(1).padStart(5) + '天'
    );
  }

  console.log('\n########## Q4 止损"误杀率"：被扫出后5日内反弹 ##########');
  console.log('口径'.padEnd(24) + '止损出场  5日内涨回买入价上方  平均反弹幅度');
  for (const [m, label] of MODES) {
    const stopped = res[m].all.filter(t => t.reason === 'stop' || t.reason === 'hardstop');
    if (!stopped.length) { console.log(label.padEnd(24) + '  无'); continue; }
    const back = stopped.filter(t => t.backAboveEntry).length;
    const avgReb = stopped.filter(t => t.rebound5 !== null).reduce((a, t) => a + t.rebound5, 0) / stopped.length;
    out[m].stopN = stopped.length; out[m].misfireRate = back / stopped.length; out[m].avgRebound = avgReb;
    console.log(label.padEnd(24) + String(stopped.length).padStart(6) + '笔  ' +
      (pct(back / stopped.length) + ' (' + back + '笔)').padStart(16) + '  ' + (avgReb * 100).toFixed(2).padStart(8) + '%');
  }

  console.log('\n########## 稳健性(前后半段) ##########');
  const ad = []; for (const s of stocks) for (const r of s.rows) ad.push(r.date);
  ad.sort(); const mid = ad[Math.floor(ad.length / 2)];
  console.log(`切分点 ${mid}`);
  out.robustness = {};
  for (const [m, label] of MODES) {
    const all = res[m].all;
    const f = metrics(all.filter(t => t.entryDate < mid)), s2 = metrics(all.filter(t => t.entryDate >= mid));
    out.robustness[m] = { first: { n: f.n, exp: f.exp, pf: f.pf }, second: { n: s2.n, exp: s2.exp, pf: s2.pf } };
    console.log(label.padEnd(24) + `前半 ${String(f.n).padStart(4)}笔 每笔${String(f.exp.toFixed(0)).padStart(5)} pf${f.pf.toFixed(2)} | 后半 ${String(s2.n).padStart(4)}笔 每笔${String(s2.exp.toFixed(0)).padStart(5)} pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_t.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_t.json');
})();
