#!/usr/bin/env node
/**
 * 研究L：持仓中出现「高点递减」时该不该卖？(2026-08-12)
 *
 * 起因：2026-08-12 用户观察到泰格连续3日冲高回落且高点递减(57.45→56.55→56.32)、
 *       同时连2日主力净流出，问"是不是可以抛售了"。
 *       现有依据不足以回答：
 *         · 研究E(2026-07-10)证伪过"资金流出即卖"(卖了5日后平均踏空+1.2~1.3%)，
 *           但**该窗口全程牛市**，报告自己标注"真正价值可能在熊市/深度回调期"；
 *         · "高点递减"这个形态**从未回测过**，属 [逻辑推演·未验证]。
 *       → 本研究补这个洞，并顺带检验研究E结论在不同行情下的稳健性。
 *
 * 三个问题：
 *   Q1 持仓中触发「连续N日高点递减」，立即卖 vs 继续持有(移动止损)，谁的期望高？
 *   Q2 「减半锁利」这个折中方案，是否优于两个极端？(这是我8/12给用户的实际建议)
 *   Q3 结论在 绞肉市/趋势市 两个半段是否一致？(直击研究E的行情局限)
 *
 * 方案（同一批进场信号，只改出场行为）：
 *   A hold      只用移动止损(MA10/前低)出场 —— baseline，即现行规则五第1条
 *   B sellAll   高点递减触发 → 次日开盘全卖
 *   C sellHalf  高点递减触发 → 次日开盘卖一半，余仓继续移动止损
 *   D sellFlow  高点递减 + 当日主力净流出 → 次日开盘全卖（叠加资金面确认）
 *
 * 口径与既有回测一致：0.15%往返成本、-8%硬顶、≤180价格上限、750元风险反推手数。
 * 次日开盘执行（非当日收盘价）——真实可执行，且避免用当日收盘价产生的前视偏差。
 */
const fs = require('fs');
const path = require('path');
const { loadStock, metrics, pool, HARD_STOP, applyCost } = require('./lib');

const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const RISK_YUAN = 750, PRICE_CAP = 180;
const DECLINE_DAYS = +(process.env.L_DAYS || 3);   // 连续几日高点递减算触发

// 进场信号：与研究K一致的纯价格版(为样本量放弃资金流条件；本研究只比出场差异)
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
    const d = (r.c - stop) / r.c;
    if (stop > 0 && d > 0 && d <= 0.04) return { kind: 'pullback', entry: r.c, stop };
  }
  return null;
}

// 「高点递减」：最近 DECLINE_DAYS 根K线的最高价严格逐日走低
function highsDeclining(rows, i, n = DECLINE_DAYS) {
  if (i < n) return false;
  for (let k = 0; k < n - 1; k++) {
    if (!(rows[i - k].h < rows[i - k - 1].h)) return false;
  }
  return true;
}

// exitMode: 'hold' | 'sellAll' | 'sellHalf' | 'sellFlow'
function simulateExit(rows, { exitMode = 'hold', maxHold = 60, name = '' } = {}) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos) {
      const avg = pos.cost / pos.shares;
      const profitPct = (r.c - avg) / avg;
      let stop = pos.stop;
      if (profitPct >= 0.05) { stop = Math.max(stop, avg); stop = Math.max(stop, pos.highest * 0.93); }
      pos.highest = Math.max(pos.highest, r.c);

      // --- 高点递减触发的减仓/清仓：**次日开盘**执行，避免前视偏差 ---
      if (pos.pendingExit && i > pos.pendingExit.day) {
        const px = r.o;                                  // 次日开盘价
        const sh = pos.pendingExit.shares;
        const cost = applyCost(avg, px, sh);
        const pnl = (px - avg) * sh - cost;
        trades.push({ stock: name, entryDate: rows[pos.i].date, exitDate: r.date, entry: avg, exit: px,
          shares: sh, pnl, pnlPct: pnl / (avg * sh), kind: pos.kind, reason: pos.pendingExit.reason, partial: sh < pos.shares });
        pos.shares -= sh;
        pos.cost = avg * pos.shares;
        pos.pendingExit = null;
        if (pos.shares <= 0) { pos = null; continue; }
      }

      // --- 常规出场 ---
      let exit = null, reason = '';
      if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= avg * HARD_STOP) { exit = avg * HARD_STOP; reason = 'hardstop'; }
      else if (i - pos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const cost = applyCost(avg, exit, pos.shares);
        const pnl = (exit - avg) * pos.shares - cost;
        trades.push({ stock: name, entryDate: rows[pos.i].date, exitDate: r.date, entry: avg, exit,
          shares: pos.shares, pnl, pnlPct: pnl / (avg * pos.shares), kind: pos.kind, reason });
        pos = null;
        continue;
      }

      // --- 高点递减判定（只在有浮盈时考虑减仓，亏损中由止损处理）---
      if (exitMode !== 'hold' && !pos.faded && profitPct > 0 && highsDeclining(rows, i)) {
        const flowOut = !isNaN(r.main) && r.main < 0;
        let sh = 0, reason2 = '';
        if (exitMode === 'sellAll') { sh = pos.shares; reason2 = 'fadeAll'; }
        else if (exitMode === 'sellHalf') { sh = Math.max(100, Math.floor(pos.shares / 2 / 100) * 100); reason2 = 'fadeHalf'; }
        else if (exitMode === 'sellFlow' && flowOut) { sh = pos.shares; reason2 = 'fadeFlow'; }
        if (sh > 0 && sh <= pos.shares) {
          pos.pendingExit = { day: i, shares: sh, reason: reason2 };
          pos.faded = true;                              // 每笔母单只触发一次
        }
      }
      pos.stop = stop;
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
    if (shares < 200) shares = 200;                      // 保证能减半
    pos = { i, cost: sig.entry * shares, shares, stop, kind: sig.kind, highest: sig.entry, faded: false, pendingExit: null };
  }
  return trades;
}

(async () => {
  console.log(`=== 研究L：高点递减(连续${DECLINE_DAYS}日)该不该卖 ===\n`);
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; }
    catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 合计 ${stocks.reduce((a, s) => a + s.rows.length, 0)} 股票日\n`);

  const plans = [
    { key: 'A_hold', mode: 'hold', label: 'A 只用移动止损(现行规则,baseline)' },
    { key: 'B_sellAll', mode: 'sellAll', label: 'B 高点递减→次日开盘全卖' },
    { key: 'C_sellHalf', mode: 'sellHalf', label: 'C 高点递减→次日开盘减半' },
    { key: 'D_sellFlow', mode: 'sellFlow', label: 'D 高点递减+主力净流出→全卖' },
  ];

  const out = {};
  const allTrades = {};
  for (const p of plans) {
    let all = [];
    for (const s of stocks) all = all.concat(simulateExit(s.rows, { exitMode: p.mode, name: s.name }));
    allTrades[p.key] = all;
    const m = metrics(all);
    const faded = all.filter(t => /^fade/.test(t.reason));
    out[p.key] = { label: p.label, all: m, fadeExits: faded.length };
    console.log(`${p.label}`);
    console.log(`  ${m.n}笔 | 胜率${(m.winRate * 100).toFixed(0)}% | 每笔${m.exp.toFixed(0)}元(${(m.expPct * 100).toFixed(2)}%) | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1)}% | 总${m.totalPnl.toFixed(0)}元${faded.length ? ` | 其中高点递减触发的离场 ${faded.length}笔` : ''}`);
  }

  console.log('\n--- Q1/Q2 对比 baseline ---');
  const base = out['A_hold'].all;
  for (const k of ['B_sellAll', 'C_sellHalf', 'D_sellFlow']) {
    const d = out[k].all.totalPnl - base.totalPnl;
    console.log(`${out[k].label}: 总盈亏差 ${d >= 0 ? '+' : ''}${d.toFixed(0)}元 | mdd ${(out[k].all.mdd * 100).toFixed(1)}% (base ${(base.mdd * 100).toFixed(1)}%)`);
  }

  // Q3 分段：直击研究E"窗口全程牛市"的局限
  console.log('\n--- Q3 分段稳健性(前半≈绞肉市 / 后半≈趋势市) ---');
  const seg = {};
  for (const p of plans) {
    const all = [...allTrades[p.key]].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const mid = Math.floor(all.length / 2);
    const h1 = metrics(all.slice(0, mid)), h2 = metrics(all.slice(mid));
    seg[p.key] = { h1, h2 };
    console.log(`${p.label}`);
    console.log(`  前半 ${h1.n}笔 每笔${h1.exp.toFixed(0)}元 pf${h1.pf.toFixed(2)} | 后半 ${h2.n}笔 每笔${h2.exp.toFixed(0)}元 pf${h2.pf.toFixed(2)}`);
  }
  console.log('\n核心问题：绞肉市里"高点递减就卖"是否比"只用移动止损"更好？');
  const a1 = seg['A_hold'].h1.exp, b1 = seg['B_sellAll'].h1.exp, c1 = seg['C_sellHalf'].h1.exp;
  const a2 = seg['A_hold'].h2.exp, b2 = seg['B_sellAll'].h2.exp, c2 = seg['C_sellHalf'].h2.exp;
  console.log(`  前半(绞肉): A持有${a1.toFixed(0)} | B全卖${b1.toFixed(0)} | C减半${c1.toFixed(0)} → ${b1 > a1 ? 'B优于A ✓(熊市该卖)' : 'B未优于A ✗'}, ${c1 > a1 ? 'C优于A ✓' : 'C未优于A ✗'}`);
  console.log(`  后半(趋势): A持有${a2.toFixed(0)} | B全卖${b2.toFixed(0)} | C减半${c2.toFixed(0)} → ${b2 > a2 ? 'B优于A ✓' : 'B未优于A ✗(牛市卖了踏空,与研究E一致)'}`);

  out._segments = seg;
  fs.writeFileSync(path.join(__dirname, 'results_l.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ 明细写入 backtest/results_l.json');
})();
