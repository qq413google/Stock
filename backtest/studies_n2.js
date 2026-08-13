#!/usr/bin/env node
/**
 * 研究N-2：冲高回落减半的「票性 × 阈值」组合矩阵 (2026-08-13 补测)
 *
 * 起因：研究N 分别测了「所有票 × 各阈值」和「各票性 × 默认5%阈值」，
 *       **唯独没测两者的组合**。用户问"泰格是趋势票，今天该不该卖"时暴露了这个遗漏——
 *       泰格今天 runUp=6.91%(<7%最优阈值) 但是趋势票(减半有效)，两个维度指向相反，
 *       不测组合就无法回答。
 *
 * 只改主流程，simulate/buySignal/regimeOf 与 studies_n.js 完全一致（直接 require 复用）。
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
function regimeOf(r) {
  const bull = r.ma5 > r.ma10 && r.ma10 > r.ma20 && r.ma20 > r.ma60;
  return (bull && r.c > r.ma60) ? 'trend' : 'range';
}
function simulate(rows, { halfSell = false, runUpTh = 0.05, fadeTh = 0.02, onlyRegime = null, maxHold = 60, name = '' } = {}) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos) {
      const avgCost = pos.cost / pos.shares;
      const profitPct = (r.c - avgCost) / avgCost;
      let stop = pos.stop;
      if (profitPct >= 0.05) { stop = Math.max(stop, avgCost); stop = Math.max(stop, pos.highest * 0.93); }
      pos.highest = Math.max(pos.highest, r.c);
      if (halfSell && !pos.halved && pos.shares >= 200 && i > pos.i) {
        const prevC = rows[i - 1].c;
        const runUp = (r.h - prevC) / prevC, fade = (r.h - r.c) / r.h;
        if (runUp > runUpTh && fade > fadeTh && (!onlyRegime || regimeOf(r) === onlyRegime)) {
          const sellSh = Math.floor(pos.shares / 2 / 100) * 100;
          if (sellSh >= 100) {
            const ac = pos.cost / pos.shares;
            pos.realized += (r.c - ac) * sellSh - applyCost(ac, r.c, sellSh);
            pos.cost -= ac * sellSh; pos.shares -= sellSh; pos.halved = true;
          }
        }
      }
      const avg2 = pos.cost / pos.shares;
      let exit = null;
      if (r.l <= stop) exit = stop;
      else if (r.c <= avg2 * HARD_STOP) exit = avg2 * HARD_STOP;
      else if (i - pos.i >= maxHold) exit = r.c;
      if (exit !== null) {
        const pnl = pos.realized + (exit - avg2) * pos.shares - applyCost(avg2, exit, pos.shares);
        trades.push({ stock: name, entryDate: rows[pos.i].date, pnl, pnlPct: pnl / pos.entryNotional, halved: !!pos.halved });
        pos = null;
      }
      pos && (pos.stop = stop);
      continue;
    }
    const sig = buySignal(rows, i);
    if (!sig) continue;
    let stop = Math.max(sig.stop, sig.entry * HARD_STOP);
    const dist = sig.entry - stop;
    if (dist <= 0) continue;
    let shares = Math.floor(RISK_YUAN / dist);
    shares = Math.min(shares, Math.floor(18000 / sig.entry));
    shares = Math.max(shares - (shares % 100), 100);
    if (shares < 100) continue;
    pos = { i, cost: sig.entry * shares, shares, stop, kind: sig.kind, highest: sig.entry, realized: 0, halved: false, entryNotional: sig.entry * shares };
  }
  return trades;
}

(async () => {
  console.log('=== 研究N-2：票性 × 阈值 组合矩阵 ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  const run = o => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { ...o, name: s.name })); return a; };
  const base = metrics(run({ halfSell: false }));
  console.log(`加载 ${stocks.length} 只 | baseline 不减半: 总${base.totalPnl.toFixed(0)}元 mdd${(base.mdd * 100).toFixed(1)}%\n`);

  const out = { baseline: { total: base.totalPnl, mdd: base.mdd }, matrix: {} };
  console.log('差额 vs 不减半(正=减半更好):');
  console.log('阈值(回落>2%)   所有票     只趋势票    只震荡票');
  for (const ru of [0.05, 0.06, 0.07, 0.08, 0.10]) {
    const row = [];
    for (const rg of [null, 'trend', 'range']) {
      const m = metrics(run({ halfSell: true, runUpTh: ru, fadeTh: 0.02, onlyRegime: rg }));
      const d = m.totalPnl - base.totalPnl;
      out.matrix[`${ru}_${rg || 'all'}`] = { total: m.totalPnl, diff: d, mdd: m.mdd, halvedN: run({ halfSell: true, runUpTh: ru, fadeTh: 0.02, onlyRegime: rg }).filter(t => t.halved).length };
      row.push(((d >= 0 ? '+' : '') + d.toFixed(0)).padStart(10));
    }
    console.log(`涨>${(ru * 100).toFixed(0)}%        ${row.join(' ')}`);
  }
  fs.writeFileSync(path.join(__dirname, 'results_n2.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_n2.json');
})();
