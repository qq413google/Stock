#!/usr/bin/env node
/**
 * 研究Q：「盈亏比 ≥2」这个门槛值得吗？ (2026-08-14)
 *
 * 起因：audit.js 列出的"无回测背书"清单里，盈亏比≥2 是参与决策最频繁的一条
 *       (几乎每笔买入都要过它)，却只是行业惯例、从未在本系统实证。用户要求测。
 *
 * 核心设计难点：**目标位在实盘是主观估的**(前高/整数关/MA60)，回测必须给客观定义，
 *   而定义方式会左右结论。故同时测三种定义，看结论是否一致(稳健性检验)：
 *     T20  前20日最高价   (短期压力，最贴近"前高"的日常用法)
 *     T60  前60日最高价   (中期压力，更保守)
 *     MA60 上方的MA60     (若价在MA60下方则用之，否则退化为T20；对应京东方那类反弹票)
 *
 * 关键认知：盈亏比在实盘是**入场筛选器**，不是出场规则。故回测中它只用于"买不买"，
 *   出场统一用已验证的移动止损(研究P的A方案: 浮盈≥5%后 max(成本,峰值×0.93)，不含MA10)。
 *   若把它当止盈目标用，测的就是另一回事了。
 *
 * 问题：
 *   Q1 盈亏比与后续实际收益是否单调相关？(高盈亏比的买点真的更好吗)
 *   Q2 门槛设在几最优？(无/≥1/≥1.5/≥2/≥2.5/≥3)
 *   Q3 三种目标位定义下结论是否一致？
 *
 * 口径与K/M/N/P一致：纯价格进场、1200日、0.15%成本、-8%硬顶、≤180上限、750元反推手数。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

// 买点信号(与前几个研究逐字一致)，额外返回 stop 供算盈亏比
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

// 三种目标位定义
function targetOf(rows, i, mode) {
  const r = rows[i];
  const hi = n => Math.max(...rows.slice(Math.max(0, i - n), i).map(x => x.h));
  if (mode === 'T20') return hi(20);
  if (mode === 'T60') return hi(60);
  if (mode === 'MA60') return r.ma60 > r.c ? r.ma60 : hi(20);   // 价在MA60下方→用MA60当天花板
  return hi(20);
}

// minRR = 盈亏比门槛(0=不筛)；出场固定用研究P的A方案
function simulate(rows, { minRR = 0, tMode = 'T20', maxHold = 60, name = '' } = {}) {
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
          reason, rr: pos.rr, kind: pos.kind, days: i - pos.i,
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
    const tgt = targetOf(rows, i, tMode);
    const rr = (tgt - sig.entry) / dist;                 // 盈亏比
    if (minRR > 0 && !(rr >= minRR)) continue;           // 门槛筛选
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
  console.log('=== 研究Q：盈亏比≥2 门槛值得吗 ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 出场固定用研究P的A方案(无MA10) | 盈亏比仅作入场筛选\n`);

  const run = o => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { ...o, name: s.name })); return a; };
  const out = {};

  // ---------- Q1: 盈亏比分档 vs 实际收益(不设门槛，看全样本分布) ----------
  console.log('########## Q1 盈亏比分档 → 实际收益 (看是否单调) ##########');
  for (const tMode of ['T20', 'T60', 'MA60']) {
    const all = run({ minRR: 0, tMode });
    const buckets = [[-Infinity, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 3], [3, 5], [5, Infinity]];
    console.log(`\n目标位定义 ${tMode} (共${all.length}笔):`);
    out[`dist_${tMode}`] = [];
    for (const [lo, hi] of buckets) {
      const g = all.filter(t => t.rr >= lo && t.rr < hi);
      if (!g.length) continue;
      const m = metrics(g);
      out[`dist_${tMode}`].push({ lo, hi, n: m.n, exp: m.exp, expPct: m.expPct, winRate: m.winRate });
      const lbl = `${lo === -Infinity ? '<0.5' : hi === Infinity ? '≥5' : `${lo}~${hi}`}`;
      console.log(`  RR ${lbl.padEnd(8)} ${String(m.n).padStart(4)}笔 | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | 每笔${(m.expPct * 100).toFixed(2)}%`);
    }
  }

  // ---------- Q2/Q3: 门槛 × 目标位定义 ----------
  console.log('\n\n########## Q2/Q3 门槛 × 目标位定义 (组合矩阵) ##########');
  const gates = [0, 1, 1.5, 2, 2.5, 3];
  for (const tMode of ['T20', 'T60', 'MA60']) {
    console.log(`\n目标位定义 ${tMode}:`);
    const base = metrics(run({ minRR: 0, tMode }));
    for (const g of gates) {
      const m = metrics(run({ minRR: g, tMode }));
      out[`gate_${tMode}_${g}`] = { n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl };
      const d = m.totalPnl - base.totalPnl;
      const keep = (m.n / base.n * 100).toFixed(0);
      console.log(`  门槛≥${String(g).padEnd(4)} ${String(m.n).padStart(4)}笔(保留${keep.padStart(3)}%) | 胜率${pct(m.winRate).padStart(4)} | 每笔${String(m.exp.toFixed(0)).padStart(5)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1).padStart(5)}% | 总${String(m.totalPnl.toFixed(0)).padStart(7)} | vs不筛${d >= 0 ? '+' : ''}${d.toFixed(0)}`);
    }
  }

  // ---------- 稳健性 ----------
  console.log('\n\n########## 稳健性(前后半段, 目标位=T20) ##########');
  const ad = []; for (const s of stocks) for (const r of s.rows) ad.push(r.date);
  ad.sort(); const mid = ad[Math.floor(ad.length / 2)];
  console.log(`切分点 ${mid}`);
  for (const g of gates) {
    const all = run({ minRR: g, tMode: 'T20' });
    const f = metrics(all.filter(t => t.entryDate < mid)), s2 = metrics(all.filter(t => t.entryDate >= mid));
    console.log(`  门槛≥${String(g).padEnd(4)} 前半 ${String(f.n).padStart(3)}笔 每笔${String(f.exp.toFixed(0)).padStart(5)}元 pf${f.pf.toFixed(2)} | 后半 ${String(s2.n).padStart(3)}笔 每笔${String(s2.exp.toFixed(0)).padStart(5)}元 pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_q.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_q.json');
})();
