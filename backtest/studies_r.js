#!/usr/bin/env node
/**
 * 研究R：盈亏比门槛在「目标位出场」框架下有效吗？ (2026-08-14)
 *
 * 起因：研究Q 证明盈亏比≥2 作为**趋势跟踪**(移动止损出场)的入场筛选器是有害的
 *       (T20定义下砍掉14万/92%利润，且RR与收益完全不单调、2~3档最差)。
 *       但Q的出场**全部是移动止损**，没有"到目标位卖出"的路径——
 *       所以它没能证明"盈亏比在震荡票上也无效"。用户要求单独测。
 *
 * 与研究Q的唯一区别：**出场方式**
 *   研究Q  出场 = 移动止损(浮盈≥5%后 max(成本,峰值×0.93))  → 趋势跟踪，目标位是虚构的
 *   研究R  出场 = 触及目标位即卖 / 止损 / 超时              → 震荡交易，目标位真会执行
 * 这正是第五节1(趋势票)与第五节2(震荡票)的两种口径。
 *
 * 问题：
 *   Q1 目标位出场框架下，盈亏比门槛能提升期望值吗？
 *   Q2 若能，最优门槛是几？
 *   Q3 只在"震荡票"(非多头排列/破MA60)上用，是否更有效？
 *   Q4 目标位出场 vs 移动止损出场，哪个总体更好？(顺便回答"震荡票该不该用目标位")
 *
 * 口径与Q一致：纯价格进场、1200日、0.15%成本、-8%硬顶、≤180上限、750元反推手数。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

function buySignal(rows, i) {
  if (i < 60) return null;
  const r = rows[i], p = rows[i - 1];
  if (!(r.ma60 > 0) || !(r.ma20 > 0)) return null;
  if (r.c > PRICE_CAP) return null;
  if ((r.c - p.c) / p.c > 0.05) return null;
  if (r.rsi > 70) return null;
  if (p.c <= p.ma20 && r.c > r.ma20) {
    const stop = Math.min(r.ma20, r.c * 0.97);
    if (stop > 0 && stop < r.c) return { kind: 'rebound', entry: r.c, stop };
  }
  const bull = r.ma5 > r.ma10 && r.ma10 > r.ma20 && r.ma20 > r.ma60;
  if (bull && r.c > r.ma60 && r.c >= r.ma10 && Math.abs(r.c - r.ma10) / r.ma10 <= 0.02 && r.volRatio < 1.0) {
    const stop = Math.min(r.ma20, r.c * 0.97);
    const dist = (r.c - stop) / r.c;
    if (stop > 0 && dist > 0 && dist <= 0.04) return { kind: 'pullback', entry: r.c, stop };
  }
  return null;
}
function targetOf(rows, i, mode) {
  const r = rows[i];
  const hi = n => Math.max(...rows.slice(Math.max(0, i - n), i).map(x => x.h));
  if (mode === 'T20') return hi(20);
  if (mode === 'T60') return hi(60);
  if (mode === 'MA60') return r.ma60 > r.c ? r.ma60 : hi(20);
  return hi(20);
}
function regimeOf(r) {
  const bull = r.ma5 > r.ma10 && r.ma10 > r.ma20 && r.ma20 > r.ma60;
  return (bull && r.c > r.ma60) ? 'trend' : 'range';
}

/**
 * exitMode: 'target' 到目标位即全卖 | 'half' 到目标位卖半仓余仓转移动止损 | 'trail' 纯移动止损(=研究Q口径)
 * onlyRegime: null | 'trend' | 'range'
 */
function simulate(rows, { minRR = 0, tMode = 'T20', exitMode = 'target', onlyRegime = null, maxHold = 60, name = '' } = {}) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos) {
      const profitPct = (r.c - pos.entry) / pos.entry;
      let stop = pos.stop;
      // 移动止损(target模式下仅对余仓/未触目标时生效，与Q口径一致)
      if (profitPct >= 0.05) { stop = Math.max(stop, pos.entry, pos.highest * 0.93); }
      pos.highest = Math.max(pos.highest, r.c);

      // half 模式：先处理半仓止盈
      if (exitMode === 'half' && !pos.halved && pos.shares >= 200 && r.h >= pos.target) {
        const sellSh = Math.floor(pos.shares / 2 / 100) * 100;
        if (sellSh >= 100) {
          pos.realized += (pos.target - pos.entry) * sellSh - applyCost(pos.entry, pos.target, sellSh);
          pos.shares -= sellSh; pos.halved = true;
        }
      }

      let exit = null, reason = '';
      if (exitMode === 'target' && r.h >= pos.target) { exit = pos.target; reason = 'target'; }
      else if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= pos.entry * HARD_STOP) { exit = pos.entry * HARD_STOP; reason = 'hardstop'; }
      else if (i - pos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const pnl = (pos.realized || 0) + (exit - pos.entry) * pos.shares - applyCost(pos.entry, exit, pos.shares);
        trades.push({
          stock: name, entryDate: rows[pos.i].date, pnl,
          pnlPct: pnl / (pos.entry * pos.origShares), reason, rr: pos.rr,
          regime: pos.regime, days: i - pos.i,
        });
        pos = null;
      }
      pos && (pos.stop = stop);
      continue;
    }
    const sig = buySignal(rows, i);
    if (!sig) continue;
    const rg = regimeOf(rows[i]);
    if (onlyRegime && rg !== onlyRegime) continue;
    let stop = Math.max(sig.stop, sig.entry * HARD_STOP);
    const dist = sig.entry - stop;
    if (dist <= 0) continue;
    const tgt = targetOf(rows, i, tMode);
    const rr = (tgt - sig.entry) / dist;
    if (!(tgt > sig.entry)) continue;                     // 目标位必须在买价上方才有意义
    if (minRR > 0 && !(rr >= minRR)) continue;
    let shares = Math.floor(RISK_YUAN / dist);
    shares = Math.min(shares, Math.floor(18000 / sig.entry));
    shares = Math.max(shares - (shares % 100), 100);
    if (shares < 100) continue;
    pos = { i, entry: sig.entry, shares, origShares: shares, stop, kind: sig.kind, highest: sig.entry, rr, target: tgt, regime: rg, realized: 0, halved: false };
  }
  return trades;
}

const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  console.log('=== 研究R：盈亏比门槛在「目标位出场」框架下有效吗 ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 与研究Q唯一区别: 出场方式\n`);
  const run = o => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { ...o, name: s.name })); return a; };
  const out = {};
  const gates = [0, 1, 1.5, 2, 2.5, 3];

  // ---------- Q1/Q2: 目标位出场 × 门槛 ----------
  console.log('########## Q1/Q2 目标位出场(到目标即全卖) × 盈亏比门槛 ##########');
  for (const tMode of ['T20', 'T60', 'MA60']) {
    console.log(`\n目标位定义 ${tMode}:`);
    const base = metrics(run({ minRR: 0, tMode, exitMode: 'target' }));
    for (const g of gates) {
      const all = run({ minRR: g, tMode, exitMode: 'target' });
      const m = metrics(all);
      const hitT = all.filter(t => t.reason === 'target').length;
      out[`tgt_${tMode}_${g}`] = { n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl, targetHitRate: hitT / m.n };
      const d = m.totalPnl - base.totalPnl;
      console.log(`  ≥${String(g).padEnd(4)} ${String(m.n).padStart(4)}笔(留${String((m.n / base.n * 100).toFixed(0)).padStart(3)}%) | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1).padStart(5)}% | 总${String(m.totalPnl.toFixed(0)).padStart(7)} | vs不筛${d >= 0 ? '+' : ''}${d.toFixed(0)} | 达标出场${pct(hitT / m.n)}`);
    }
  }

  // ---------- Q3: 只在震荡票上 ----------
  console.log('\n\n########## Q3 只在震荡票(非多头/破MA60)上用目标位出场 ##########');
  for (const tMode of ['T20', 'MA60']) {
    console.log(`\n目标位定义 ${tMode} (仅震荡票):`);
    const base = metrics(run({ minRR: 0, tMode, exitMode: 'target', onlyRegime: 'range' }));
    for (const g of gates) {
      const m = metrics(run({ minRR: g, tMode, exitMode: 'target', onlyRegime: 'range' }));
      out[`range_${tMode}_${g}`] = { n: m.n, exp: m.exp, pf: m.pf, total: m.totalPnl };
      const d = m.totalPnl - base.totalPnl;
      console.log(`  ≥${String(g).padEnd(4)} ${String(m.n).padStart(4)}笔 | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | pf${m.pf.toFixed(2)} | 总${String(m.totalPnl.toFixed(0)).padStart(7)} | vs不筛${d >= 0 ? '+' : ''}${d.toFixed(0)}`);
    }
  }

  // ---------- Q4: 三种出场方式横向对比(不设门槛) ----------
  console.log('\n\n########## Q4 出场方式横向对比 (不设盈亏比门槛, T20) ##########');
  for (const [em, lbl] of [['trail', '纯移动止损(研究Q口径/第五节1)'], ['target', '到目标位全卖(第五节2)'], ['half', '到目标位卖半仓+余仓移动止损(第五节2原文)']]) {
    for (const rg of [null, 'trend', 'range']) {
      const m = metrics(run({ minRR: 0, tMode: 'T20', exitMode: em, onlyRegime: rg }));
      out[`exit_${em}_${rg || 'all'}`] = { n: m.n, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl };
      console.log(`  ${lbl.padEnd(34)} ${(rg || '全部').padEnd(6)} ${String(m.n).padStart(4)}笔 | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1).padStart(5)}% | 总${String(m.totalPnl.toFixed(0)).padStart(7)}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'results_r.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_r.json');
})();
