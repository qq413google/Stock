#!/usr/bin/env node
/**
 * 研究Q-2：盈亏比能当「垃圾过滤器」吗？(低门槛细测, 2026-08-14)
 *
 * 起因：研究Q/R 证明盈亏比≥2 在两种出场框架下都无效，我建议降级为参考；
 *       但标注了局限3——**盈亏比还可能起"否决明显不划算交易"的作用**(如 RR=0.3)，
 *       完全废止或许会放进一批垃圾。用户要求补测。
 *
 * 问题：
 *   Q1 极低盈亏比(RR<0.5)的交易，实际表现真的更差吗？
 *   Q2 存不存在一个低门槛(0.3/0.5/0.8/1.0)能提升组合表现？
 *   Q3 若不存在 → 说明在移动止损框架下，目标位根本不参与出场决策，
 *      盈亏比只是个"与结果无关的数字"，应彻底移出硬闸门。
 *
 * 出场固定用已验证最优的移动止损(研究P的A方案)，与研究Q口径一致。
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
function simulate(rows, { minRR = -999, maxRR = 999, tMode = 'T20', maxHold = 60, name = '' } = {}) {
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
        trades.push({ stock: name, entryDate: rows[pos.i].date, pnl, pnlPct: (exit - pos.entry) / pos.entry, reason, rr: pos.rr, days: i - pos.i });
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
    const rr = (targetOf(rows, i, tMode) - sig.entry) / dist;
    if (!(rr >= minRR && rr < maxRR)) continue;
    let shares = Math.floor(RISK_YUAN / dist);
    shares = Math.min(shares, Math.floor(18000 / sig.entry));
    shares = Math.max(shares - (shares % 100), 100);
    if (shares < 100) continue;
    pos = { i, entry: sig.entry, shares, stop, kind: sig.kind, highest: sig.entry, rr };
  }
  return trades;
}
const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  console.log('=== 研究Q-2：盈亏比能当垃圾过滤器吗(低门槛细测) ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length} 只 | 出场固定移动止损(研究P的A方案)\n`);
  const run = o => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { ...o, name: s.name })); return a; };
  const out = {};

  // Q1: 低区间细分
  console.log('########## Q1 低盈亏比区间细分 (这些真是"垃圾"吗) ##########');
  const lowBuckets = [[-999, 0], [0, 0.3], [0.3, 0.5], [0.5, 0.8], [0.8, 1.0], [1.0, 1.5], [1.5, 999]];
  for (const tMode of ['T20', 'T60', 'MA60']) {
    console.log(`\n目标位 ${tMode}:`);
    out[`bucket_${tMode}`] = [];
    for (const [lo, hi] of lowBuckets) {
      const m = metrics(run({ minRR: lo, maxRR: hi, tMode }));
      if (!m.n) { console.log(`  RR ${lo}~${hi}: 无样本`); continue; }
      out[`bucket_${tMode}`].push({ lo, hi, n: m.n, exp: m.exp, expPct: m.expPct, winRate: m.winRate, pf: m.pf });
      const lbl = lo === -999 ? '<0(目标位在买价下方)' : hi === 999 ? '≥1.5' : `${lo}~${hi}`;
      console.log(`  RR ${lbl.padEnd(22)} ${String(m.n).padStart(4)}笔 | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | ${(m.expPct * 100).toFixed(2).padStart(6)}% | pf${m.pf.toFixed(2)}`);
    }
  }

  // Q2: 低门槛
  console.log('\n\n########## Q2 低门槛能提升组合表现吗 ##########');
  const gates = [-999, 0, 0.3, 0.5, 0.8, 1.0, 1.2];
  for (const tMode of ['T20', 'T60', 'MA60']) {
    console.log(`\n目标位 ${tMode}:`);
    const base = metrics(run({ minRR: -999, tMode }));
    for (const g of gates) {
      const m = metrics(run({ minRR: g, tMode }));
      out[`gate_${tMode}_${g}`] = { n: m.n, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl };
      const d = m.totalPnl - base.totalPnl;
      const lbl = g === -999 ? '不筛' : `≥${g}`;
      console.log(`  ${lbl.padEnd(6)} ${String(m.n).padStart(4)}笔(留${String((m.n / base.n * 100).toFixed(0)).padStart(3)}%) | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1).padStart(5)}% | 总${String(m.totalPnl.toFixed(0)).padStart(7)} | vs不筛${d >= 0 ? '+' : ''}${d.toFixed(0)}`);
    }
  }

  // Q3: 相关性 —— RR 与实际收益率
  console.log('\n\n########## Q3 盈亏比与实际收益的相关系数 ##########');
  for (const tMode of ['T20', 'T60', 'MA60']) {
    const all = run({ minRR: -999, tMode }).filter(t => isFinite(t.rr));
    const n = all.length;
    const mx = all.reduce((a, t) => a + t.rr, 0) / n, my = all.reduce((a, t) => a + t.pnlPct, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (const t of all) { num += (t.rr - mx) * (t.pnlPct - my); dx += (t.rr - mx) ** 2; dy += (t.pnlPct - my) ** 2; }
    const corr = num / Math.sqrt(dx * dy);
    out[`corr_${tMode}`] = corr;
    console.log(`  ${tMode}: r = ${corr.toFixed(4)} (${Math.abs(corr) < 0.05 ? '几乎零相关 —— 盈亏比对结果无预测力' : Math.abs(corr) < 0.15 ? '极弱相关' : '有一定相关'})`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_q2.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_q2.json');
})();
