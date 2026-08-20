#!/usr/bin/env node
/**
 * 研究U：「突破买」这一类买点值不值得启用？(2026-08-20)
 *
 * 起因：用户 2026-08-20 说"购买策略基本只能高处跌回3%并且企稳，感觉只有一个买点"。
 *       核查发现感觉有据——规则第二节写了**三类**合法买点，但 arm-alerts.js 只布防两类：
 *           1 回踩支撑买 → ✅ "反弹收复MA10/MA20"
 *           2 突破买     → ❌ **无任何触发器**
 *           3 超跌反包买 → ✅ "站回MA20"
 *       实盘8笔里突破买 0 笔——不是它不好，是**系统从没提醒过**。
 *       而策略共识「二·补3」(2026-07-09 中兴那次)早已写过同一个元教训：
 *       "策略写了3个买点却只给前1.5个建了监控——工具覆盖<策略定义，会系统性漏掉整类机会"。
 *       当时补了反包，**突破至今没补，同一缺口存在一个半月**。
 *
 * 第0问执行结果：`studies.js:40` 已有"突破回踩"定义、results.json 里有24笔分布计数，
 *       但**从未单独统计过它的收益**（只有 dist 计数，无 metrics）。故本研究不是重复劳动。
 *
 * 问题：
 *   Q1 三类买点各自的期望值是多少？突破买是否值得启用？
 *   Q2 v2.14 的「当日涨>3%禁买」会不会把突破买直接掐死？(突破当天往往涨幅大)
 *   Q3 启用突破买后，组合总收益/回撤如何变化？机会数增加多少？
 *
 * 买点定义**逐字复用 studies.js 的 buyPoints()**（保持与既往回测同口径）：
 *   回踩   : |价-MA10|/MA10 < 2% 且 价≥MA10 且 昨日价≥昨日MA20
 *   突破回踩: 近5日内出现过"收盘≥前20日最高" 且 价 ≤ MA20×1.03 且 价 > MA20
 *   反包   : 价>MA20 且 昨日价≤昨日MA20
 *   (反包原定义还要求 mainRatio≥10 & volRatio<1，纯价格模式下无资金流字段，故省略——
 *    与研究K/M/N/P/Q/S 的处理一致，各方案同口径可比)
 *
 * 其余固定为当前已验证的最优配置：止损 min(MA20,价×0.97)、
 * 移动止损 浮盈≥5%后 max(成本,峰值收盘×0.93)（研究P的A方案，不含MA10）、
 * 0.15%成本、-8%硬顶、≤180上限、750元风险反推仓位。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

// 三类买点识别（逐字复用 studies.js buyPoints 口径）
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

/**
 * kinds: 允许的买点类型集合
 * chaseGate: 当日涨幅禁买阈值(0.03=v2.14现行, null=不禁)
 */
function simulate(rows, { kinds = ['pullback', 'rebound'], chaseGate = 0.03, maxHold = 60, name = '' } = {}) {
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
        trades.push({ stock: name, entryDate: rows[pos.i].date, pnl, pnlPct: (exit - pos.entry) / pos.entry, reason, kind: pos.kind, days: i - pos.i });
        pos = null;
      }
      pos && (pos.stop = stop);
      continue;
    }
    if (i < 60) continue;
    const p = rows[i - 1];
    if (!(r.ma60 > 0)) continue;
    if (r.c > PRICE_CAP) continue;
    if (r.rsi > 70) continue;                                   // 已验证的超买闸门
    const chg = (r.c - p.c) / p.c;
    if (chaseGate !== null && chg > chaseGate) continue;        // 当日涨幅禁买
    const kind = buyPointKind(rows, i);
    if (!kind || !kinds.includes(kind)) continue;
    let stop = Math.min(r.ma20, r.c * 0.97);
    if (!(stop > 0) || stop >= r.c) continue;
    stop = Math.max(stop, r.c * HARD_STOP);
    const dist = r.c - stop;
    if (dist <= 0) continue;
    let shares = Math.floor(RISK_YUAN / dist);
    shares = Math.min(shares, Math.floor(18000 / r.c));
    shares = Math.max(shares - (shares % 100), 100);
    if (shares < 100) continue;
    pos = { i, entry: r.c, shares, stop, kind, highest: r.c };
  }
  return trades;
}

const pct = x => (x * 100).toFixed(0) + '%';
const KN = { pullback: '回踩支撑', breakout: '突破买', rebound: '超跌反包' };

(async () => {
  console.log('=== 研究U：「突破买」值不值得启用 ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 止损min(MA20,价×0.97) | 移动止损=研究P的A方案\n`);
  const run = o => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { ...o, name: s.name })); return a; };
  const out = {};

  // ---------- Q1 三类买点各自的期望值 ----------
  console.log('########## Q1 三类买点单独跑（含v2.14的3%禁买）##########');
  console.log('买点类型'.padEnd(12) + '笔数  胜率  每笔    pf    回撤    总盈亏');
  for (const k of ['pullback', 'breakout', 'rebound']) {
    const m = metrics(run({ kinds: [k], chaseGate: 0.03 }));
    out['solo_' + k] = { n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl };
    if (!m.n) { console.log(KN[k].padEnd(12) + '  0笔（该类型在3%禁买下完全无机会）'); continue; }
    console.log(KN[k].padEnd(12) + String(m.n).padStart(4) + '  ' + pct(m.winRate).padStart(4) + '  ' +
      String(m.exp.toFixed(0)).padStart(5) + '  ' + m.pf.toFixed(2) + '  ' + (m.mdd * 100).toFixed(1).padStart(5) + '%  ' + String(m.totalPnl.toFixed(0)).padStart(8));
  }

  // ---------- Q2 3%禁买对各类型的杀伤 ----------
  console.log('\n########## Q2 「涨>3%禁买」对各买点的杀伤（有闸门 vs 无闸门）##########');
  console.log('买点类型'.padEnd(12) + '有3%闸门     无闸门      被砍掉');
  for (const k of ['pullback', 'breakout', 'rebound']) {
    const withG = metrics(run({ kinds: [k], chaseGate: 0.03 }));
    const noG = metrics(run({ kinds: [k], chaseGate: null }));
    out['gate_' + k] = { withGate: withG.n, noGate: noG.n, withTotal: withG.totalPnl, noTotal: noG.totalPnl };
    const cut = noG.n ? (1 - withG.n / noG.n) : 0;
    console.log(KN[k].padEnd(12) + String(withG.n).padStart(4) + '笔 ' + String(withG.totalPnl.toFixed(0)).padStart(8) +
      '  ' + String(noG.n).padStart(4) + '笔 ' + String(noG.totalPnl.toFixed(0)).padStart(8) + '  ' + pct(cut).padStart(5));
  }

  // ---------- Q3 组合对比 ----------
  console.log('\n########## Q3 组合：现状(两类) vs 启用突破(三类) ##########');
  const COMBOS = [
    [['pullback', 'rebound'], '现状：回踩+反包（系统只监控这两类）'],
    [['pullback', 'rebound', 'breakout'], '启用突破：三类全开'],
    [['pullback'], '仅回踩'],
    [['breakout'], '仅突破'],
  ];
  const base = metrics(run({ kinds: ['pullback', 'rebound'], chaseGate: 0.03 }));
  console.log('方案'.padEnd(38) + '笔数  胜率  每笔    pf    回撤    总盈亏     vs现状');
  for (const [ks, label] of COMBOS) {
    const m = metrics(run({ kinds: ks, chaseGate: 0.03 }));
    out['combo_' + ks.join('+')] = { label, n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl };
    const d = m.totalPnl - base.totalPnl;
    console.log(label.padEnd(38) + String(m.n).padStart(4) + '  ' + pct(m.winRate).padStart(4) + '  ' +
      String(m.exp.toFixed(0)).padStart(5) + '  ' + m.pf.toFixed(2) + '  ' + (m.mdd * 100).toFixed(1).padStart(5) + '%  ' +
      String(m.totalPnl.toFixed(0)).padStart(8) + '  ' + (d >= 0 ? '+' : '') + d.toFixed(0));
  }

  // ---------- 稳健性 ----------
  console.log('\n########## 稳健性(前后半段) ##########');
  const ad = []; for (const s of stocks) for (const r of s.rows) ad.push(r.date);
  ad.sort(); const mid = ad[Math.floor(ad.length / 2)];
  console.log(`切分点 ${mid}`);
  out.robustness = {};
  for (const [ks, label] of COMBOS) {
    const all = run({ kinds: ks, chaseGate: 0.03 });
    const f = metrics(all.filter(t => t.entryDate < mid)), s2 = metrics(all.filter(t => t.entryDate >= mid));
    out.robustness[ks.join('+')] = { first: { n: f.n, exp: f.exp, pf: f.pf }, second: { n: s2.n, exp: s2.exp, pf: s2.pf } };
    console.log(label.padEnd(38) + `前半 ${String(f.n).padStart(4)}笔 每笔${String(f.exp.toFixed(0)).padStart(5)} pf${f.pf.toFixed(2)} | 后半 ${String(s2.n).padStart(4)}笔 每笔${String(s2.exp.toFixed(0)).padStart(5)} pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_u.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_u.json');
})();
