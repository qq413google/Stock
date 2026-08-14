#!/usr/bin/env node
/**
 * 研究S：「当日涨>5% 禁买」这条硬闸门还站得住吗？ (2026-08-14)
 *
 * 起因：v2.13 废止盈亏比门槛后，本条的论证基础塌了一半——
 *       它原本的正当性写的是"**「盈亏比≥2」的快速代理**"(risk-management 第二节)。
 *       而研究F(2026-07-10)当时已经发现两件事：
 *         ① 作为"预测下跌"的信号 **不成立**——涨幅越大后续5日反而涨得更多(+1.8%→+2.5%)
 *         ② 但作为"盈亏比代理"的机制性论点成立(止损距离随涨幅单调拉大8.5%→16.3%)
 *       当时靠 ② 保留了这条规则。现在 ② 的落脚点(盈亏比)已被 Q/R/Q-2 证伪，
 *       必须直接测：**这条禁买本身对组合收益是正是负？**
 *
 * 问题：
 *   Q1 禁买阈值设在几最优？(完全不禁 / >3% / >5%(现行) / >7% / >10%)
 *   Q2 按买点类型拆分，结论是否一致？(超跌反包天然涨幅大，回踩天然涨幅小)
 *   Q3 当日涨幅分档 → 实际收益，是否单调？(复核研究F的①)
 *
 * 出场固定用已验证最优的移动止损(研究P的A方案: 浮盈≥5%后 max(成本,峰值×0.93)，不含MA10)。
 * 不含盈亏比筛选(v2.13已废止)。其余口径与K/M/N/P/Q一致。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

// maxChg = 当日涨幅上限(禁买阈值)；999 = 完全不禁
function buySignal(rows, i, maxChg) {
  if (i < 60) return null;
  const r = rows[i], p = rows[i - 1];
  if (!(r.ma60 > 0) || !(r.ma20 > 0)) return null;
  if (r.c > PRICE_CAP) return null;
  const chg = (r.c - p.c) / p.c;
  if (chg > maxChg) return null;                       // ← 本研究的自变量
  if (r.rsi > 70) return null;
  if (p.c <= p.ma20 && r.c > r.ma20) {
    const stop = Math.min(r.ma20, r.c * 0.97);
    if (stop > 0 && stop < r.c) return { kind: 'rebound', entry: r.c, stop, chg };
  }
  const bull = r.ma5 > r.ma10 && r.ma10 > r.ma20 && r.ma20 > r.ma60;
  if (bull && r.c > r.ma60 && r.c >= r.ma10 && Math.abs(r.c - r.ma10) / r.ma10 <= 0.02 && r.volRatio < 1.0) {
    const stop = Math.min(r.ma20, r.c * 0.97);
    const dist = (r.c - stop) / r.c;
    if (stop > 0 && dist > 0 && dist <= 0.04) return { kind: 'pullback', entry: r.c, stop, chg };
  }
  return null;
}

function simulate(rows, { maxChg = 0.05, onlyKind = null, maxHold = 60, name = '' } = {}) {
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
        trades.push({
          stock: name, entryDate: rows[pos.i].date, pnl, pnlPct: (exit - pos.entry) / pos.entry,
          reason, kind: pos.kind, chg: pos.chg, days: i - pos.i,
        });
        pos = null;
      }
      pos && (pos.stop = stop);
      continue;
    }
    const sig = buySignal(rows, i, maxChg);
    if (!sig) continue;
    if (onlyKind && sig.kind !== onlyKind) continue;
    let stop = Math.max(sig.stop, sig.entry * HARD_STOP);
    const dist = sig.entry - stop;
    if (dist <= 0) continue;
    let shares = Math.floor(RISK_YUAN / dist);
    shares = Math.min(shares, Math.floor(18000 / sig.entry));
    shares = Math.max(shares - (shares % 100), 100);
    if (shares < 100) continue;
    pos = { i, entry: sig.entry, shares, stop, kind: sig.kind, highest: sig.entry, chg: sig.chg };
  }
  return trades;
}
const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  console.log('=== 研究S：「当日涨>5%禁买」还站得住吗 ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 出场=移动止损(研究P的A方案) | 无盈亏比筛选(v2.13废止)\n`);
  const run = o => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { ...o, name: s.name })); return a; };
  const out = {};
  const gates = [0.03, 0.05, 0.07, 0.10, 999];
  const lbl = g => g === 999 ? '完全不禁' : `>${(g * 100).toFixed(0)}%禁买`;

  // ---------- Q1 主对比 ----------
  console.log('########## Q1 禁买阈值对比 ##########');
  const cur = metrics(run({ maxChg: 0.05 }));
  for (const g of gates) {
    const m = metrics(run({ maxChg: g }));
    out[`gate_${g}`] = { n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl };
    const d = m.totalPnl - cur.totalPnl;
    console.log(`  ${lbl(g).padEnd(10)} ${String(m.n).padStart(4)}笔 | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1).padStart(5)}% | 总${String(m.totalPnl.toFixed(0)).padStart(7)} | vs现行(>5%)${d >= 0 ? '+' : ''}${d.toFixed(0)}`);
  }

  // ---------- Q2 按买点类型 ----------
  console.log('\n########## Q2 按买点类型拆分 ##########');
  for (const k of ['rebound', 'pullback']) {
    console.log(`\n${k === 'rebound' ? '超跌反包(站回MA20,天然涨幅大)' : '顺势回踩(天然涨幅小)'}:`);
    const base = metrics(run({ maxChg: 0.05, onlyKind: k }));
    for (const g of gates) {
      const m = metrics(run({ maxChg: g, onlyKind: k }));
      out[`${k}_${g}`] = { n: m.n, exp: m.exp, pf: m.pf, total: m.totalPnl };
      const d = m.totalPnl - base.totalPnl;
      console.log(`  ${lbl(g).padEnd(10)} ${String(m.n).padStart(4)}笔 | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | pf${m.pf.toFixed(2)} | 总${String(m.totalPnl.toFixed(0)).padStart(7)} | vs>5%${d >= 0 ? '+' : ''}${d.toFixed(0)}`);
    }
  }

  // ---------- Q3 涨幅分档 → 实际收益(复核研究F①) ----------
  console.log('\n########## Q3 当日涨幅分档 → 实际收益 (复核研究F①) ##########');
  const all = run({ maxChg: 999 });
  const buckets = [[-999, 0], [0, 0.02], [0.02, 0.05], [0.05, 0.07], [0.07, 0.10], [0.10, 999]];
  out.dist = [];
  for (const [lo, hi] of buckets) {
    const g = all.filter(t => t.chg >= lo && t.chg < hi);
    if (!g.length) continue;
    const m = metrics(g);
    out.dist.push({ lo, hi, n: m.n, exp: m.exp, expPct: m.expPct, winRate: m.winRate, pf: m.pf });
    const l = lo === -999 ? '<0%' : hi === 999 ? '≥10%' : `${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}%`;
    console.log(`  当日涨 ${l.padEnd(8)} ${String(m.n).padStart(4)}笔 | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | ${(m.expPct * 100).toFixed(2).padStart(6)}% | pf${m.pf.toFixed(2)}`);
  }

  // ---------- 稳健性 ----------
  console.log('\n########## 稳健性(前后半段) ##########');
  const ad = []; for (const s of stocks) for (const r of s.rows) ad.push(r.date);
  ad.sort(); const mid = ad[Math.floor(ad.length / 2)];
  console.log(`切分点 ${mid}`);
  out.robustness = {};
  for (const g of gates) {
    const a = run({ maxChg: g });
    const f = metrics(a.filter(t => t.entryDate < mid)), s2 = metrics(a.filter(t => t.entryDate >= mid));
    out.robustness[g] = { first: { n: f.n, exp: f.exp, pf: f.pf }, second: { n: s2.n, exp: s2.exp, pf: s2.pf } };
    console.log(`  ${lbl(g).padEnd(10)} 前半 ${String(f.n).padStart(3)}笔 每笔${String(f.exp.toFixed(0)).padStart(5)}元 pf${f.pf.toFixed(2)} | 后半 ${String(s2.n).padStart(3)}笔 每笔${String(s2.exp.toFixed(0)).padStart(5)}元 pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_s.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_s.json');
})();
