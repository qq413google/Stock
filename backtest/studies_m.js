#!/usr/bin/env node
/**
 * 研究M：加仓门槛"浮盈≥5%"这个阈值本身 (2026-08-13)
 *
 * 起因：2026-08-12 梳理"加仓位怎么算"时向用户承认——研究K验证的是"加仓vs不加仓"和
 *       "加仓后止损口径"，**从未测过 5% 这个门槛数字本身**。它只是沿用的约定。
 *       用户："测一下？" → 本研究。
 *
 * 问题：
 *   Q1 浮盈门槛设在几% 最优？(0/2/3/5/8/10/15%)
 *   Q2 门槛与加仓形态(回踩/突破/都要)有无交互作用？
 *   Q3 5% 是不是恰好在最优点附近，还是纯属拍脑袋碰巧？
 *
 * ⚠️ 关键实现坑：simulateAdd 里有**两个不同的 5%**——
 *   (a) 加仓门槛  profitPct >= 0.05   ← 本研究的自变量
 *   (b) 移动止损  profitPct >= 0.05 时抬保本+highest*0.93  ← 出场逻辑，**必须固定不动**
 *   若一起改，测的就不是"加仓门槛"而是"两个参数的混合效应"，结论无效。
 *
 * 口径与研究K完全一致(便于横向对照)：纯价格进场信号、1200日窗口、0.15%成本、
 * -8%硬顶、≤180价格上限、750元风险反推首仓、加仓固定1手、单票限1次。
 * 止损口径固定为 keep(维持原止损)——研究K已证明其最优(+15,556元/回撤14.6%)。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

// ---------- 进场信号：与研究K逐字一致 ----------
function buySignal(rows, i) {
  if (i < 60) return null;
  const r = rows[i], p = rows[i - 1];
  if (!(r.ma60 > 0) || !(r.ma20 > 0)) return null;
  if (r.c > PRICE_CAP) return null;
  const chg = (r.c - p.c) / p.c;
  if (chg > 0.05) return null;
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

function addSignal(rows, i, mode) {
  const r = rows[i];
  if (!(r.ma10 > 0)) return false;
  if (mode === 'breakout' || mode === 'both') {
    const prevHigh = Math.max(...rows.slice(Math.max(0, i - 20), i).map(x => x.h));
    if (r.c > prevHigh) return true;
  }
  if (mode === 'pullback' || mode === 'both') {
    if (r.c >= r.ma10 && Math.abs(r.c - r.ma10) / r.ma10 <= 0.02 && r.volRatio < 1.0) return true;
  }
  return false;
}

// addThreshold = 加仓门槛(自变量)；移动止损里的 0.05 固定不动
function simulateAdd(rows, { addForm = 'pullback', addThreshold = 0.05, maxHold = 60, name = '' } = {}) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos) {
      const avgCost = pos.cost / pos.shares;
      const profitPct = (r.c - avgCost) / avgCost;
      let stop = pos.stop;
      // 出场侧移动止损：固定 5%，不随自变量变化
      if (profitPct >= 0.05) { stop = Math.max(stop, avgCost); stop = Math.max(stop, pos.highest * 0.93); }
      pos.highest = Math.max(pos.highest, r.c);

      // 加仓：门槛为自变量 addThreshold；止损口径固定 keep(不动)
      if (!pos.added && profitPct >= addThreshold && addSignal(rows, i, addForm)) {
        const addShares = Math.min(100, pos.shares);
        if (r.c <= PRICE_CAP) {
          pos.cost += r.c * addShares;
          pos.shares += addShares;
          pos.added = true;
          pos.addProfitPct = profitPct;   // 记录加仓时的实际浮盈，供分布分析
          pos.stop = stop;                 // keep
        }
      }

      const avg2 = pos.cost / pos.shares;
      let exit = null, reason = '';
      if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= avg2 * HARD_STOP) { exit = avg2 * HARD_STOP; reason = 'hardstop'; }
      else if (i - pos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const cost = applyCost(avg2, exit, pos.shares);
        const pnl = (exit - avg2) * pos.shares - cost;
        trades.push({
          stock: name, entryDate: rows[pos.i].date, exitDate: r.date, entry: avg2, exit,
          shares: pos.shares, pnl, pnlPct: pnl / (avg2 * pos.shares), kind: pos.kind, reason,
          added: !!pos.added, addProfitPct: pos.addProfitPct ?? null,
        });
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
    pos = { i, cost: sig.entry * shares, shares, stop, kind: sig.kind, highest: sig.entry, added: false };
  }
  return trades;
}

function fmt(label, all) {
  const m = metrics(all);
  const added = all.filter(t => t.added);
  const ma = added.length ? metrics(added) : null;
  return {
    label, n: m.n, winRate: m.winRate, exp: m.exp, expPct: m.expPct, pf: m.pf, mdd: m.mdd, total: m.totalPnl,
    addN: added.length,
    addWin: ma ? ma.winRate : null, addExp: ma ? ma.exp : null, addExpPct: ma ? ma.expPct : null,
  };
}

(async () => {
  console.log('=== 研究M：加仓门槛"浮盈≥X%"阈值测试 ===\n');
  const loaded = await pool(wl, async s => {
    try {
      const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false });
      return rows.length > 120 ? { name: s.name, rows } : null;
    } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 纯价格信号 | 合计 ${stocks.reduce((a, s) => a + s.rows.length, 0)} 股票日`);
  console.log(`固定: 止损口径=keep(研究K最优) | 加仓1手 | 单票限1次 | 移动止损5%不变\n`);

  const thresholds = [0, 0.02, 0.03, 0.05, 0.08, 0.10, 0.15];
  const forms = ['pullback', 'both', 'breakout'];
  const out = { thresholds, forms, results: {} };

  for (const form of forms) {
    console.log(`\n########## 加仓形态: ${form} ##########`);
    // baseline: 不加仓(用极高门槛模拟)
    let base = [];
    for (const s of stocks) base = base.concat(simulateAdd(s.rows, { addForm: form, addThreshold: 999, name: s.name }));
    const bm = metrics(base);
    console.log(`baseline 不加仓: ${bm.n}笔 | 胜率${(bm.winRate * 100).toFixed(0)}% | 每笔${bm.exp.toFixed(0)}元 | pf${bm.pf.toFixed(2)} | mdd${(bm.mdd * 100).toFixed(1)}% | 总${bm.totalPnl.toFixed(0)}元`);
    out.results[form] = { baseline: fmt('baseline', base), byThreshold: {} };

    for (const th of thresholds) {
      let all = [];
      for (const s of stocks) all = all.concat(simulateAdd(s.rows, { addForm: form, addThreshold: th, name: s.name }));
      const r = fmt(`th=${(th * 100).toFixed(0)}%`, all);
      out.results[form].byThreshold[th] = r;
      const delta = r.total - bm.totalPnl;
      console.log(
        `门槛≥${String((th * 100).toFixed(0)).padStart(2)}%: ${String(r.n).padStart(4)}笔 | 胜率${(r.winRate * 100).toFixed(0)}% | 每笔${String(r.exp.toFixed(0)).padStart(4)}元 | pf${r.pf.toFixed(2)} | mdd${(r.mdd * 100).toFixed(1)}% | 总${String(r.total.toFixed(0)).padStart(7)}元 | vs不加仓${delta >= 0 ? '+' : ''}${delta.toFixed(0)} | 加仓${String(r.addN).padStart(3)}笔胜率${r.addWin !== null ? (r.addWin * 100).toFixed(0) + '%' : '--'}`
      );
    }
  }

  // ---------- 稳健性：前后半段 ----------
  console.log(`\n\n--- 稳健性检验(按入场日期切前后半段, 形态=pullback) ---`);
  const allDates = [];
  for (const s of stocks) for (const r of s.rows) allDates.push(r.date);
  allDates.sort();
  const mid = allDates[Math.floor(allDates.length / 2)];
  console.log(`切分点: ${mid}`);
  out.robustness = { mid, pullback: {} };
  for (const th of thresholds) {
    let all = [];
    for (const s of stocks) all = all.concat(simulateAdd(s.rows, { addForm: 'pullback', addThreshold: th, name: s.name }));
    const first = all.filter(t => t.entryDate < mid), second = all.filter(t => t.entryDate >= mid);
    const f = metrics(first), sc = metrics(second);
    out.robustness.pullback[th] = { first: { n: f.n, exp: f.exp, pf: f.pf }, second: { n: sc.n, exp: sc.exp, pf: sc.pf } };
    console.log(`门槛≥${String((th * 100).toFixed(0)).padStart(2)}%: 前半 ${String(f.n).padStart(3)}笔 每笔${String(f.exp.toFixed(0)).padStart(4)}元 pf${f.pf.toFixed(2)} | 后半 ${String(sc.n).padStart(3)}笔 每笔${String(sc.exp.toFixed(0)).padStart(4)}元 pf${sc.pf.toFixed(2)}`);
  }

  // ---------- 加仓时实际浮盈的分布 ----------
  console.log(`\n--- 门槛=0时, 加仓实际发生在多少浮盈处(看门槛是否真起作用) ---`);
  let z = [];
  for (const s of stocks) z = z.concat(simulateAdd(s.rows, { addForm: 'pullback', addThreshold: 0, name: s.name }));
  const profits = z.filter(t => t.added && t.addProfitPct !== null).map(t => t.addProfitPct).sort((a, b) => a - b);
  if (profits.length) {
    const q = p => profits[Math.floor(profits.length * p)];
    console.log(`加仓${profits.length}笔 | 浮盈分位: p10=${(q(0.1) * 100).toFixed(1)}% p25=${(q(0.25) * 100).toFixed(1)}% p50=${(q(0.5) * 100).toFixed(1)}% p75=${(q(0.75) * 100).toFixed(1)}% p90=${(q(0.9) * 100).toFixed(1)}%`);
    for (const th of [0.02, 0.03, 0.05, 0.08, 0.10, 0.15]) {
      const kept = profits.filter(p => p >= th).length;
      console.log(`  门槛${(th * 100).toFixed(0)}% 会保留 ${kept}/${profits.length} 笔 (${(kept / profits.length * 100).toFixed(0)}%)`);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'results_m.json'), JSON.stringify(out, null, 2));
  console.log(`\n✅ 明细写入 backtest/results_m.json`);
})();
