#!/usr/bin/env node
/**
 * 研究K：金字塔加仓的期望值 + 加仓后止损口径 (2026-08-10)
 *
 * 起因：v2.8(2026-08-07用户提出、08-10生效)放行"加仓豁免当日涨>5%"，同时我(Claude)自创了
 *       一条收紧条款"加仓后整体止损必须≥保本位"——**该条零回测依据**，纯逻辑推演。
 *       08-10 泰格实盘触发加仓时，我用这条自制约束建议"不加"，被用户追问依据后承认：
 *       加仓策略本身从未回测过。本研究补这个洞。
 *
 * 问题：
 *   Q1 金字塔加仓 vs 不加仓，组合期望值谁高？
 *   Q2 加仓后止损用哪种口径最优：保本位(v2.8现行) / MA10移动 / 维持原止损？
 *   Q3 加仓触发形态：突破前高确认 vs 回踩MA10不破，哪个更好？
 *
 * 方案对比（同一批进场信号，只改加仓行为）：
 *   A none      不加仓（baseline）
 *   B breakeven 加仓 + 整体止损抬到保本位（= v2.8 现行条款）
 *   C ma10      加仓 + 整体止损用 MA10（不强制保本，容错更大）
 *   D keep      加仓 + 维持原止损不变（最宽松）
 *
 * 口径与既有回测一致：0.15%往返成本、-8%硬顶、≤180价格上限、单笔风险750元反推首仓手数。
 * 加仓固定 1 手(100股)，金字塔减量原则下不超过首仓。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;

// ---------- 进场信号：沿用已回测验证的两类买点 ----------
// 顺势回踩(studies.js buyPoints 口径) + 超跌反包(站回MA20+主力净占比≥10%)
// ⚠️ 样本量决策(2026-08-10)：首版带资金流条件跑出来全池仅5笔、加仓1~2笔，无法支撑任何结论
// (资金流接口硬上限120交易日)。**本研究的对象是"加仓行为"，不是"进场信号"**——只要各方案
// 进场信号完全一致，对比就成立。故改用**纯价格进场信号 + 1200日窗口**换取样本量，
// 代价是进场信号不等同于实盘所用的完整闸门(少了主力净流入这一最强项)，绝对收益数字会偏离实盘，
// **但方案间的相对差异仍可比**。这是有意识的取舍，不是遗漏。
const USE_FLOW = process.env.K_USE_FLOW === '1';
function buySignal(rows, i) {
  if (i < 60) return null;
  const r = rows[i], p = rows[i - 1];
  if (!(r.ma60 > 0) || !(r.ma20 > 0)) return null;
  if (r.c > PRICE_CAP) return null;
  const chg = (r.c - p.c) / p.c;
  if (chg > 0.05) return null;                       // 当日涨>5%禁买
  if (USE_FLOW && !(r.main > 0)) return null;        // 当日主力净流入(仅带资金流模式)
  if (r.rsi > 70) return null;                       // 非超买(回测验证)

  // 超跌反包：昨收≤MA20 且 今收>MA20 (带资金流模式再要求净占比≥10%)
  if (p.c <= p.ma20 && r.c > r.ma20 && (!USE_FLOW || r.mainRatio >= 10)) {
    const stop = Math.min(r.ma20, r.c * 0.97);
    if (stop > 0 && stop < r.c) return { kind: 'rebound', entry: r.c, stop };
  }
  // 顺势回踩：多头排列 + 站MA60 + 贴近MA10(±2%) + 缩量 + 止损距离≤4%
  const bull = r.ma5 > r.ma10 && r.ma10 > r.ma20 && r.ma20 > r.ma60;
  if (bull && r.c > r.ma60 && r.c >= r.ma10 && Math.abs(r.c - r.ma10) / r.ma10 <= 0.02 && r.volRatio < 1.0) {
    const stop = Math.min(r.ma20, r.c * 0.97);
    const dist = (r.c - stop) / r.c;
    if (stop > 0 && dist > 0 && dist <= 0.04) return { kind: 'pullback', entry: r.c, stop };
  }
  return null;
}

// ---------- 加仓触发 ----------
// 形态1 突破前高确认：收盘创近20日新高(不含当日之前的最高)，且非当日涨>9%的极端
// 形态2 回踩不破企稳：浮盈中回踩到MA10附近(±2%)且未跌破MA10，缩量
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

// ---------- 支持金字塔加仓的模拟器 ----------
// addMode: 'none' | 'breakeven' | 'ma10' | 'keep'
// addForm: 'breakout' | 'pullback' | 'both'
function simulateAdd(rows, { addMode = 'none', addForm = 'breakout', maxHold = 60, name = '' } = {}) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos) {
      const avgCost = pos.cost / pos.shares;
      const profitPct = (r.c - avgCost) / avgCost;
      // --- 移动止损(与既有引擎一致: 浮盈≥5%抬保本 + highest*0.93) ---
      let stop = pos.stop;
      if (profitPct >= 0.05) { stop = Math.max(stop, avgCost); stop = Math.max(stop, pos.highest * 0.93); }
      pos.highest = Math.max(pos.highest, r.c);

      // --- 加仓判定(每笔最多1次, 浮盈≥5%, 且有加仓形态) ---
      if (addMode !== 'none' && !pos.added && profitPct >= 0.05 && addSignal(rows, i, addForm)) {
        const addShares = Math.min(100, pos.shares);          // 金字塔减量: ≤首仓, 固定1手
        if (r.c <= PRICE_CAP) {
          pos.cost += r.c * addShares;
          pos.shares += addShares;
          pos.added = true;
          pos.addPrice = r.c;
          const newAvg = pos.cost / pos.shares;
          if (addMode === 'breakeven') pos.stop = Math.max(stop, newAvg);        // v2.8: 整体止损≥保本位
          else if (addMode === 'ma10') pos.stop = Math.max(stop, r.ma10);        // MA10移动止损
          else pos.stop = stop;                                                   // keep: 不动
          stop = pos.stop;
        }
      }

      // --- 出场 ---
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
          added: !!pos.added, addPrice: pos.addPrice || null, firstEntry: pos.firstEntry,
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
    pos = { i, cost: sig.entry * shares, shares, stop, kind: sig.kind, highest: sig.entry, added: false, firstEntry: sig.entry };
  }
  return trades;
}

(async () => {
  console.log('=== 研究K：金字塔加仓期望值 + 止损口径 ===\n');
  const loaded = await pool(wl, async s => {
    try {
      const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: USE_FLOW });
      return rows.length > 120 ? { name: s.name, rows } : null;
    } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  const totalDays = stocks.reduce((a, s) => a + s.rows.length, 0);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 模式: ${USE_FLOW ? '带资金流(窗口≈120日)' : '纯价格(窗口≈1200日)'} | 合计 ${totalDays} 股票日\n`);

  const plans = [
    { key: 'A_none', addMode: 'none', addForm: 'breakout', label: 'A 不加仓(baseline)' },
    { key: 'B_breakeven', addMode: 'breakeven', addForm: 'breakout', label: 'B 加仓+保本位止损(v2.8现行)' },
    { key: 'C_ma10', addMode: 'ma10', addForm: 'breakout', label: 'C 加仓+MA10止损' },
    { key: 'D_keep', addMode: 'keep', addForm: 'breakout', label: 'D 加仓+原止损不变' },
    { key: 'E_pullback_be', addMode: 'breakeven', addForm: 'pullback', label: 'E 回踩加仓+保本位' },
    { key: 'F_pullback_ma10', addMode: 'ma10', addForm: 'pullback', label: 'F 回踩加仓+MA10止损' },
    // 2026-08-10 补测: 在已证明最优的"维持原止损"口径下, 对比两种加仓形态——
    // 用户实盘加在突破当日冲高处(56.70,当日区间69%分位),追问"加仓位置是不是错了",
    // 需要数据回答"突破当天加 vs 等回踩加"哪个位置更好。
    { key: 'G_pullback_keep', addMode: 'keep', addForm: 'pullback', label: 'G 回踩加仓+维持原止损' },
    { key: 'H_both_keep', addMode: 'keep', addForm: 'both', label: 'H 突破或回踩都加+维持原止损' },
  ];

  const out = {};
  for (const p of plans) {
    let all = [];
    for (const s of stocks) all = all.concat(simulateAdd(s.rows, { addMode: p.addMode, addForm: p.addForm, name: s.name }));
    const m = metrics(all);
    const addedTrades = all.filter(t => t.added);
    const mAdd = metrics(addedTrades);
    out[p.key] = { label: p.label, all: m, addedOnly: mAdd, addedCount: addedTrades.length };
    console.log(`${p.label}`);
    console.log(`  全部 ${m.n}笔 | 胜率${(m.winRate * 100).toFixed(0)}% | 每笔${m.exp.toFixed(0)}元(${(m.expPct * 100).toFixed(2)}%) | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1)}% | 总${m.totalPnl.toFixed(0)}元`);
    if (addedTrades.length) console.log(`  其中实际加过仓的 ${mAdd.n}笔 | 胜率${(mAdd.winRate * 100).toFixed(0)}% | 每笔${mAdd.exp.toFixed(0)}元(${(mAdd.expPct * 100).toFixed(2)}%)`);
    console.log('');
  }

  // 对齐比较：只看"发生过加仓"的那些交易，各方案下同一批母单的差异
  console.log('--- 关键对比(仅统计实际触发加仓的母单) ---');
  const base = out['A_none'].all;
  for (const k of ['B_breakeven', 'C_ma10', 'D_keep', 'E_pullback_be', 'F_pullback_ma10']) {
    const o = out[k];
    const d = o.all.totalPnl - base.totalPnl;
    console.log(`${o.label}: 总盈亏差 ${d >= 0 ? '+' : ''}${d.toFixed(0)}元 | 加仓${o.addedCount}笔 | mdd ${(o.all.mdd * 100).toFixed(1)}% (vs baseline ${(base.mdd * 100).toFixed(1)}%)`);
  }

  // ---------- 稳健性检验：按入场日期切前后两半，看结论是否稳定 ----------
  console.log('\n--- 稳健性检验(按入场日期切前后半段) ---');
  const seg = {};
  for (const p of plans) {
    let all = [];
    for (const s of stocks) all = all.concat(simulateAdd(s.rows, { addMode: p.addMode, addForm: p.addForm, name: s.name }));
    all.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const mid = Math.floor(all.length / 2);
    const h1 = metrics(all.slice(0, mid)), h2 = metrics(all.slice(mid));
    seg[p.key] = { h1, h2, splitDate: all[mid] ? all[mid].entryDate : null };
    console.log(`${p.label}`);
    console.log(`  前半(${all[0]?.entryDate}~) ${h1.n}笔 每笔${h1.exp.toFixed(0)}元 pf${h1.pf.toFixed(2)} | 后半(${all[mid]?.entryDate}~) ${h2.n}笔 每笔${h2.exp.toFixed(0)}元 pf${h2.pf.toFixed(2)}`);
  }
  const bA = seg['A_none'], bB = seg['B_breakeven'], bD = seg['D_keep'];
  console.log('\n核心问题：保本位止损(B) 在两个半段是否都劣于 不加仓(A) 与 原止损(D)?');
  console.log(`  前半: A每笔${bA.h1.exp.toFixed(0)} | B每笔${bB.h1.exp.toFixed(0)} | D每笔${bD.h1.exp.toFixed(0)} → B${bB.h1.exp < bA.h1.exp ? '劣于A ✓' : '未劣于A ✗'}, ${bB.h1.exp < bD.h1.exp ? 'B劣于D ✓' : 'B未劣于D ✗'}`);
  console.log(`  后半: A每笔${bA.h2.exp.toFixed(0)} | B每笔${bB.h2.exp.toFixed(0)} | D每笔${bD.h2.exp.toFixed(0)} → B${bB.h2.exp < bA.h2.exp ? '劣于A ✓' : '未劣于A ✗'}, ${bB.h2.exp < bD.h2.exp ? 'B劣于D ✓' : 'B未劣于D ✗'}`);

  out._segments = seg;
  fs.writeFileSync(path.join(__dirname, 'results_k.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ 明细写入 backtest/results_k.json');
})();
