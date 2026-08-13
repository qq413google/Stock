#!/usr/bin/env node
/**
 * 研究O：减半锁利之后，允许"恢复"被减掉的仓位吗？ (2026-08-13)
 *
 * 起因：泰格 08-13 按第五节3减半(200→100股)后，用户问"后续(明天后天)还能补回一手吗"。
 *       现行 v2.8「单票最多加1次」+ 已加仓标记 → **永远不能再加**。但该规则本意是防
 *       "越加越多、敞口失控"，而减半后敞口已缩回原点，风险累积根本没发生——
 *       规则的字面盖过了它的目的。用户与Claude都倾向允许恢复(方案B)，但用户要求先回测。
 *
 * 问题：
 *   Q1 减半后允许恢复 vs 不允许，总收益谁高？
 *   Q2 恢复该用什么触发形态(回踩/突破/都行)？
 *   Q3 恢复是否应限次数？(测1次 vs 不限次)
 *
 * 完整路径：建仓 → 加仓(浮盈≥5%+形态,限1次) → 减半(涨>7%且回落>2%,v2.11)
 *           → 【恢复?本研究自变量】 → 移动止损出场
 *
 * 固定为当前已验证的最优配置(便于隔离"恢复"的边际价值)：
 *   - 加仓门槛 5%(研究M峰值)、加仓限1次、加仓后维持原止损(研究K最优)
 *   - 减半阈值 涨>7%/回落>2%(研究N最优)
 *   - 移动止损: 浮盈≥5%后 max(保本, 峰值×0.93)
 *
 * ⚠️ 局限（与N一致）：日K近似，减半/恢复均按**收盘价**成交；纯价格进场信号；in-sample。
 *   另：恢复只买回"被减掉的股数"，不超过减半前水平——这是方案B的定义，不是最优化搜索。
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

// 加仓/恢复共用的形态判定
function formSignal(rows, i, mode) {
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

/**
 * restoreMode: 'none' 不允许恢复 | 'once' 限1次 | 'unlimited' 不限次
 * restoreForm: 恢复的触发形态
 */
function simulate(rows, {
  addForm = 'pullback', addTh = 0.05,
  halfRunUp = 0.07, halfFade = 0.02,
  restoreMode = 'none', restoreForm = 'pullback',
  maxHold = 60, name = '',
} = {}) {
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

      // --- 加仓(限1次) ---
      if (!pos.added && profitPct >= addTh && formSignal(rows, i, addForm) && r.c <= PRICE_CAP) {
        const addSh = Math.min(100, pos.baseShares);
        pos.cost += r.c * addSh; pos.shares += addSh; pos.added = true;
      }

      // --- 减半(v2.11 阈值; 需≥200股) ---
      if (!pos.halved && pos.shares >= 200 && i > pos.i) {
        const prevC = rows[i - 1].c;
        const runUp = (r.h - prevC) / prevC, fade = (r.h - r.c) / r.h;
        if (runUp > halfRunUp && fade > halfFade) {
          const sellSh = Math.floor(pos.shares / 2 / 100) * 100;
          if (sellSh >= 100) {
            const ac = pos.cost / pos.shares;
            pos.realized += (r.c - ac) * sellSh - applyCost(ac, r.c, sellSh);
            pos.cost -= ac * sellSh; pos.shares -= sellSh;
            pos.halved = true; pos.halvedShares = sellSh; pos.restoreCount = 0;
          }
        }
      }

      // --- 恢复：买回被减掉的量(不超过减半前水平) ---
      if (restoreMode !== 'none' && pos.halved && pos.halvedShares > 0 && r.c <= PRICE_CAP) {
        const canRestore = restoreMode === 'unlimited' || pos.restoreCount < 1;
        if (canRestore && formSignal(rows, i, restoreForm)) {
          const sh = pos.halvedShares;
          pos.cost += r.c * sh; pos.shares += sh;
          pos.restoreCount++; pos.restored = true;
          pos.halvedShares = 0;          // 已恢复，需再次减半才能再恢复
          pos.halved = restoreMode === 'unlimited' ? false : true;  // unlimited 允许再走一轮
        }
      }

      const avg2 = pos.cost / pos.shares;
      let exit = null, reason = '';
      if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= avg2 * HARD_STOP) { exit = avg2 * HARD_STOP; reason = 'hardstop'; }
      else if (i - pos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const pnl = pos.realized + (exit - avg2) * pos.shares - applyCost(avg2, exit, pos.shares);
        trades.push({
          stock: name, entryDate: rows[pos.i].date, exitDate: r.date, pnl,
          pnlPct: pnl / pos.entryNotional, kind: pos.kind, reason,
          added: !!pos.added, halved: !!pos.halvedEver || !!pos.halved || pos.restoreCount > 0,
          restored: !!pos.restored, restoreCount: pos.restoreCount || 0,
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
    pos = {
      i, cost: sig.entry * shares, shares, baseShares: shares, stop, kind: sig.kind,
      highest: sig.entry, realized: 0, added: false, halved: false, halvedShares: 0,
      restoreCount: 0, restored: false, entryNotional: sig.entry * shares,
    };
  }
  return trades;
}

const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  console.log('=== 研究O：减半后允许"恢复"仓位吗 ===\n');
  const loaded = await pool(wl, async s => {
    try {
      const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false });
      return rows.length > 120 ? { name: s.name, rows } : null;
    } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 固定: 加仓门槛5%限1次+维持原止损 | 减半7%/2% | 日K近似(收盘价成交)\n`);

  const run = o => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { ...o, name: s.name })); return a; };
  const out = {};

  const plans = [
    { key: 'A', label: 'A 不允许恢复 (=现行v2.8, baseline)', o: { restoreMode: 'none' } },
    { key: 'B_pull', label: 'B 恢复1次, 回踩形态', o: { restoreMode: 'once', restoreForm: 'pullback' } },
    { key: 'B_break', label: 'B 恢复1次, 突破形态', o: { restoreMode: 'once', restoreForm: 'breakout' } },
    { key: 'B_both', label: 'B 恢复1次, 回踩或突破', o: { restoreMode: 'once', restoreForm: 'both' } },
    { key: 'C_unlim', label: 'C 不限次恢复, 回踩形态', o: { restoreMode: 'unlimited', restoreForm: 'pullback' } },
  ];

  console.log('########## Q1/Q2/Q3 主对比 ##########');
  const base = run(plans[0].o); const bm = metrics(base);
  for (const p of plans) {
    const all = run(p.o); const m = metrics(all);
    const rs = all.filter(t => t.restored);
    out[p.key] = { label: p.label, n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl, restoredN: rs.length };
    const d = m.totalPnl - bm.totalPnl;
    console.log(`${p.label}\n  ${m.n}笔 | 胜率${pct(m.winRate)} | 每笔${m.exp.toFixed(0)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1)}% | 总${m.totalPnl.toFixed(0)} | vs不恢复${d >= 0 ? '+' : ''}${d.toFixed(0)} | 恢复${rs.length}笔`);
  }

  // 同一批母单配对比较(只看真正发生恢复的)
  console.log('\n########## 配对比较: 发生恢复的母单, 恢复 vs 不恢复 ##########');
  const idx = new Map(base.map(t => [`${t.stock}|${t.entryDate}`, t]));
  for (const key of ['B_pull', 'B_break', 'B_both']) {
    const p = plans.find(x => x.key === key);
    const all = run(p.o);
    const pairs = all.filter(t => t.restored).map(t => ({ r: t, b: idx.get(`${t.stock}|${t.entryDate}`) })).filter(x => x.b);
    if (!pairs.length) { console.log(`${p.label}: 无恢复样本`); continue; }
    const sr = pairs.reduce((a, x) => a + x.r.pnl, 0), sb = pairs.reduce((a, x) => a + x.b.pnl, 0);
    const better = pairs.filter(x => x.r.pnl > x.b.pnl).length;
    out[`pair_${key}`] = { n: pairs.length, restoreTotal: sr, holdTotal: sb, diff: sr - sb, betterRate: better / pairs.length };
    console.log(`${p.label} — ${pairs.length}笔:`);
    console.log(`  恢复 总${sr.toFixed(0)} 每笔${(sr / pairs.length).toFixed(0)} | 不恢复 总${sb.toFixed(0)} 每笔${(sb / pairs.length).toFixed(0)}`);
    console.log(`  → 差额 ${sr - sb >= 0 ? '+' : ''}${(sr - sb).toFixed(0)}元 | 恢复更优占 ${better}/${pairs.length} (${pct(better / pairs.length)})`);
  }

  // 稳健性
  console.log('\n########## 稳健性(前后半段) ##########');
  const ad = []; for (const s of stocks) for (const r of s.rows) ad.push(r.date);
  ad.sort(); const mid = ad[Math.floor(ad.length / 2)];
  console.log(`切分点 ${mid}`);
  out.robustness = {};
  for (const p of plans) {
    const all = run(p.o);
    const f = metrics(all.filter(t => t.entryDate < mid)), s2 = metrics(all.filter(t => t.entryDate >= mid));
    out.robustness[p.key] = { first: { n: f.n, exp: f.exp, pf: f.pf }, second: { n: s2.n, exp: s2.exp, pf: s2.pf } };
    console.log(`${p.label}\n  前半 ${f.n}笔 每笔${f.exp.toFixed(0)}元 pf${f.pf.toFixed(2)} | 后半 ${s2.n}笔 每笔${s2.exp.toFixed(0)}元 pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_o.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ 明细写入 backtest/results_o.json');
})();
