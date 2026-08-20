#!/usr/bin/env node
/**
 * 研究V：涨幅禁买阈值该不该按买点类型分开设？(2026-08-20)
 *
 * 起因：研究U 拆到买点类型层后发现——v2.14 的「当日涨>3%禁买」代价极不均匀：
 *       回踩 砍 2% 机会 / 突破 砍 4% / **超跌反包 砍 52%**
 *       反包无闸门时总盈亏 214,370，加上3%闸门后只剩 125,664，**代价 -88,706**。
 *       研究S(2026-08-14)当时只测总体、未拆到类型层，故"一刀切3%"可能过度惩罚了反包。
 *
 * 第0问执行：grep 规则文件与 backtest/ —— 差异化阈值**从未测过**，v2.16 版本历史里
 *       仅记录为"待单独验证"。确认不是重复劳动。
 *
 * 问题：
 *   Q1 只放宽反包的阈值(3→5/7/10/不禁)，其余维持3%，总收益与回撤如何变化？
 *   Q2 差异化阈值 vs 一刀切(全3%/全5%/全不禁)，哪个的"每单位回撤收益"最优？
 *   Q3 用户明确"回撤扛不到32%"——哪些方案在这条红线内？
 *
 * ⚠️ 为什么反包对涨幅阈值特别敏感（机制）：
 *   反包买点的定义是"昨收≤MA20 且 今收>MA20"——**站回均线那天通常本身就是大阳线**，
 *   涨幅天然偏高；而回踩买点定义在 MA10 附近±2%，涨幅天然小。
 *   所以同一条涨幅线，对两类买点的杀伤完全不同。
 *
 * 口径与研究U完全一致（三类买点全开 = v2.16 现行）：止损 min(MA20,价×0.97)、
 * 移动止损 浮盈≥5%后 max(成本,峰值×0.93)、0.15%成本、-8%硬顶、≤180上限、750元反推仓位。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

function buyPointKind(r, i) {
  if (i < 1) return null;
  const c = r[i];
  if (!(c.ma10 > 0) || !(c.ma20 > 0)) return null;
  if (Math.abs(c.c - c.ma10) / c.ma10 < 0.02 && c.c >= c.ma10 && r[i - 1].c >= r[i - 1].ma20) return 'pullback';
  let newHigh = false;
  for (let k = Math.max(0, i - 5); k <= i; k++) {
    const w = Math.max(...r.slice(Math.max(0, k - 20), k + 1).map(x => x.c));
    if (r[k].c >= w) newHigh = true;
  }
  if (newHigh && c.c <= c.ma20 * 1.03 && c.c > c.ma20) return 'breakout';
  if (c.c > c.ma20 && r[i - 1].c <= r[i - 1].ma20) return 'rebound';
  return null;
}

// gates: 每类买点各自的涨幅上限，null = 不禁
function simulate(rows, { gates, maxHold = 60, name = '' } = {}) {
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
        trades.push({ stock: name, entryDate: rows[pos.i].date, pnl, pnlPct: (exit - pos.entry) / pos.entry, reason, kind: pos.kind, chg: pos.chg });
        pos = null;
      }
      pos && (pos.stop = stop);
      continue;
    }
    if (i < 60) continue;
    const p = rows[i - 1];
    if (!(r.ma60 > 0) || r.c > PRICE_CAP || r.rsi > 70) continue;
    const kind = buyPointKind(rows, i);
    if (!kind) continue;
    const g = gates[kind];
    const chg = (r.c - p.c) / p.c;
    if (g !== null && chg > g) continue;
    let stop = Math.min(r.ma20, r.c * 0.97);
    if (!(stop > 0) || stop >= r.c) continue;
    stop = Math.max(stop, r.c * HARD_STOP);
    const dist = r.c - stop;
    if (dist <= 0) continue;
    let shares = Math.floor(RISK_YUAN / dist);
    shares = Math.min(shares, Math.floor(18000 / r.c));
    shares = Math.max(shares - (shares % 100), 100);
    if (shares < 100) continue;
    pos = { i, entry: r.c, shares, stop, kind, highest: r.c, chg };
  }
  return trades;
}

const pct = x => (x * 100).toFixed(0) + '%';
const G = (pb, bo, rb) => ({ pullback: pb, breakout: bo, rebound: rb });

(async () => {
  console.log('=== 研究V：涨幅禁买阈值要不要按买点类型分开设 ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 三类买点全开(v2.16现行) | 只变涨幅阈值\n`);
  const run = g => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { gates: g, name: s.name })); return a; };
  const out = {};

  const PLANS = [
    ['现状 全部3% (v2.14+v2.16)', G(0.03, 0.03, 0.03)],
    ['反包放宽到5%, 其余3%', G(0.03, 0.03, 0.05)],
    ['反包放宽到7%, 其余3%', G(0.03, 0.03, 0.07)],
    ['反包放宽到10%, 其余3%', G(0.03, 0.03, 0.10)],
    ['反包完全不禁, 其余3%', G(0.03, 0.03, null)],
    ['反包7%+突破5%, 回踩3%', G(0.03, 0.05, 0.07)],
    ['一刀切 全部5%', G(0.05, 0.05, 0.05)],
    ['一刀切 全部7%', G(0.07, 0.07, 0.07)],
    ['完全不禁', G(null, null, null)],
  ];

  console.log('########## Q1/Q2 各方案对比 ##########');
  console.log('方案'.padEnd(28) + '笔数  胜率  每笔    pf   回撤    总盈亏    每单位回撤收益');
  const base = metrics(run(G(0.03, 0.03, 0.03)));
  const rows2 = [];
  for (const [label, g] of PLANS) {
    const all = run(g);
    const m = metrics(all);
    const eff = m.mdd > 0 ? m.totalPnl / (m.mdd * 100) : 0;
    out[label] = { n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl, effPerMdd: eff, vsBase: m.totalPnl - base.totalPnl };
    rows2.push({ label, m, eff });
    console.log(label.padEnd(28) + String(m.n).padStart(4) + '  ' + pct(m.winRate).padStart(4) + '  ' +
      String(m.exp.toFixed(0)).padStart(5) + '  ' + m.pf.toFixed(2) + '  ' + (m.mdd * 100).toFixed(1).padStart(5) + '%  ' +
      String(m.totalPnl.toFixed(0)).padStart(8) + '  ' + String(Math.round(eff)).padStart(8) +
      (Math.abs(m.totalPnl - base.totalPnl) > 1 ? '  (' + (m.totalPnl - base.totalPnl >= 0 ? '+' : '') + (m.totalPnl - base.totalPnl).toFixed(0) + ')' : ''));
  }

  console.log('\n########## Q3 用户红线：回撤 ≤32% 的方案 ##########');
  const okRows = rows2.filter(r => r.m.mdd <= 0.32).sort((a, b) => b.m.totalPnl - a.m.totalPnl);
  const badRows = rows2.filter(r => r.m.mdd > 0.32);
  console.log('✅ 红线内(按总盈亏排序):');
  okRows.forEach(r => console.log('   ' + r.label.padEnd(28) + '回撤' + (r.m.mdd * 100).toFixed(1).padStart(5) + '%  总' + String(r.m.totalPnl.toFixed(0)).padStart(8) + '  效率' + Math.round(r.eff)));
  if (badRows.length) { console.log('🔴 超出红线(不可选):'); badRows.forEach(r => console.log('   ' + r.label.padEnd(28) + '回撤' + (r.m.mdd * 100).toFixed(1).padStart(5) + '%')); }

  console.log('\n########## 反包类被放宽后，多出来的那批交易质量如何 ##########');
  const strict = run(G(0.03, 0.03, 0.03)).filter(t => t.kind === 'rebound');
  const loose = run(G(0.03, 0.03, null)).filter(t => t.kind === 'rebound');
  const strictKeys = new Set(strict.map(t => t.stock + '|' + t.entryDate));
  const extra = loose.filter(t => !strictKeys.has(t.stock + '|' + t.entryDate));
  if (extra.length) {
    const em = metrics(extra), sm = metrics(strict);
    out.extraRebound = { n: em.n, exp: em.exp, pf: em.pf, winRate: em.winRate, total: em.totalPnl };
    console.log(`  3%以内的反包(现状能买)  ${String(sm.n).padStart(4)}笔  每笔${String(sm.exp.toFixed(0)).padStart(5)}元  胜率${pct(sm.winRate)}  pf${sm.pf.toFixed(2)}`);
    console.log(`  涨幅>3%的反包(现状禁买) ${String(em.n).padStart(4)}笔  每笔${String(em.exp.toFixed(0)).padStart(5)}元  胜率${pct(em.winRate)}  pf${em.pf.toFixed(2)}  总${em.totalPnl.toFixed(0)}元`);
    console.log(`  → 被禁掉的这批${em.exp > sm.exp ? '**质量更高**' : '质量更低'}，${em.exp > 0 ? '是正期望' : '是负期望'}`);
  }

  console.log('\n########## 稳健性(前后半段) ##########');
  const ad = []; for (const s of stocks) for (const r of s.rows) ad.push(r.date);
  ad.sort(); const mid = ad[Math.floor(ad.length / 2)];
  console.log(`切分点 ${mid}`);
  out.robustness = {};
  for (const [label, g] of PLANS) {
    const all = run(g);
    const f = metrics(all.filter(t => t.entryDate < mid)), s2 = metrics(all.filter(t => t.entryDate >= mid));
    out.robustness[label] = { first: { n: f.n, exp: f.exp, pf: f.pf }, second: { n: s2.n, exp: s2.exp, pf: s2.pf } };
    console.log(label.padEnd(28) + `前半 ${String(f.n).padStart(4)}笔 每笔${String(f.exp.toFixed(0)).padStart(5)} pf${f.pf.toFixed(2)} | 后半 ${String(s2.n).padStart(4)}笔 每笔${String(s2.exp.toFixed(0)).padStart(5)} pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_v.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_v.json');
})();
