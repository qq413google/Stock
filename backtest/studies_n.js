#!/usr/bin/env node
/**
 * 研究N：冲高回落减半锁利 vs 持有到移动止损 (2026-08-13)
 *
 * 起因：泰格医药 08-13 日内涨6.91%后回落2.42%，触发第五节3「冲高回落减半锁利」。
 *       复核发现该时刻**主力仍净流入+0.67亿、价在均价线上方**，是健康回落非派发；
 *       且泰格是趋势票(多头排列)，第五节1明确要求趋势票"不预设固定目标价提前下车"。
 *       **同一节里两条规则对趋势票给出相反指令**，而第五节3的 5%/2% 从未回测过。
 *       用户按条文减半后追问"需要回测验证吗" → 本研究。
 *
 * 问题：
 *   Q1 冲高回落减半 vs 不减(持有到移动止损)，总收益谁高？
 *   Q2 趋势票和震荡票的结论是否相反？(若是，则第五节3应收窄到只对震荡票生效)
 *   Q3 阈值(涨幅门槛/回落门槛)在什么位置最优？5%/2% 是否碰巧合理？
 *
 * ⚠️ 日K近似（必须知道的局限）：
 *   实盘是**盘中实时**触发(回落到2%那一刻减半)，日K只能看到 open/high/low/close。
 *   本研究用「当日 high 相对昨收涨>X% 且 close 相对 high 回落>Y%」判定触发，
 *   **减半成交价用收盘价**。这比实盘保守——实盘在回落刚到2%时卖，价格通常高于收盘。
 *   因此本研究会**低估减半方案的收益**，若结论仍是"减半更差"，那是稳健的；
 *   若结论是"减半更好"，则实盘只会更好，方向一致。这个偏差是单向的，可接受。
 *
 * 口径与研究K/M一致：纯价格进场信号、1200日窗口、0.15%成本、-8%硬顶、≤180上限、
 * 750元风险反推首仓、移动止损(浮盈≥5%抬保本+峰值×0.93)。不含加仓(隔离变量)。
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

// 触发当日的票性：趋势票 = 多头排列 + 站MA60；否则震荡票
function regimeOf(r) {
  const bull = r.ma5 > r.ma10 && r.ma10 > r.ma20 && r.ma20 > r.ma60;
  return (bull && r.c > r.ma60) ? 'trend' : 'range';
}

/**
 * halfSell: false=不减(baseline) | true=触发时减半
 * runUpTh / fadeTh: 冲高回落的两个阈值
 * onlyRegime: null=所有票 | 'trend' | 'range'  —— 只对该类票执行减半
 */
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

      // --- 冲高回落减半(每笔最多1次, 需≥200股才能真减半) ---
      if (halfSell && !pos.halved && pos.shares >= 200 && i > pos.i) {
        const prevC = rows[i - 1].c;
        const runUp = (r.h - prevC) / prevC;
        const fade = (r.h - r.c) / r.h;
        const regimeOk = !onlyRegime || regimeOf(r) === onlyRegime;
        if (runUp > runUpTh && fade > fadeTh && regimeOk) {
          const sellSh = Math.floor(pos.shares / 2 / 100) * 100;
          if (sellSh >= 100) {
            const px = r.c;                                  // 保守: 用收盘价成交
            const fee = applyCost(avgCost, px, sellSh);
            pos.realized += (px - avgCost) * sellSh - fee;
            pos.cost -= avgCost * sellSh;
            pos.shares -= sellSh;
            pos.halved = true;
            pos.halveRegime = regimeOf(r);
          }
        }
      }

      const avg2 = pos.cost / pos.shares;
      let exit = null, reason = '';
      if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= avg2 * HARD_STOP) { exit = avg2 * HARD_STOP; reason = 'hardstop'; }
      else if (i - pos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const fee = applyCost(avg2, exit, pos.shares);
        const pnl = pos.realized + (exit - avg2) * pos.shares - fee;
        trades.push({
          stock: name, entryDate: rows[pos.i].date, exitDate: r.date, pnl,
          pnlPct: pnl / (pos.entryNotional || 1), kind: pos.kind, reason,
          halved: !!pos.halved, halveRegime: pos.halveRegime || null,
          entryRegime: pos.entryRegime,
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
      i, cost: sig.entry * shares, shares, stop, kind: sig.kind, highest: sig.entry,
      realized: 0, halved: false, entryNotional: sig.entry * shares, entryRegime: regimeOf(rows[i]),
    };
  }
  return trades;
}

const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  console.log('=== 研究N：冲高回落减半 vs 持有到移动止损 ===\n');
  const loaded = await pool(wl, async s => {
    try {
      const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false });
      return rows.length > 120 ? { name: s.name, rows } : null;
    } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | 纯价格信号 | ${stocks.reduce((a, s) => a + s.rows.length, 0)} 股票日`);
  console.log(`⚠️ 日K近似: 减半成交价用收盘价(比实盘保守, 会低估减半收益)\n`);

  const run = opts => { let all = []; for (const s of stocks) all = all.concat(simulate(s.rows, { ...opts, name: s.name })); return all; };
  const out = {};

  // ---------- Q1/Q2 主对比 ----------
  const plans = [
    { key: 'A_hold', label: 'A 不减半, 持有到移动止损(baseline)', o: { halfSell: false } },
    { key: 'B_half_all', label: 'B 冲高回落减半(所有票, =第五节3现行)', o: { halfSell: true } },
    { key: 'C_half_trend', label: 'C 只对趋势票减半', o: { halfSell: true, onlyRegime: 'trend' } },
    { key: 'D_half_range', label: 'D 只对震荡票减半', o: { halfSell: true, onlyRegime: 'range' } },
  ];
  console.log('########## Q1/Q2 主对比 ##########');
  const base = run(plans[0].o); const bm = metrics(base);
  for (const p of plans) {
    const all = run(p.o); const m = metrics(all);
    const halved = all.filter(t => t.halved);
    out[p.key] = { label: p.label, n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl, halvedN: halved.length };
    const d = m.totalPnl - bm.totalPnl;
    console.log(`${p.label}\n  ${m.n}笔 | 胜率${pct(m.winRate)} | 每笔${m.exp.toFixed(0)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1)}% | 总${m.totalPnl.toFixed(0)}元 | vs不减${d >= 0 ? '+' : ''}${d.toFixed(0)} | 减半${halved.length}笔`);
  }

  // ---------- 按票性拆分(只看真正触发减半的那批母单) ----------
  console.log('\n########## 按票性拆分: 减半 vs 不减 (同一批母单) ##########');
  const allHalf = run({ halfSell: true });
  const idx = new Map(base.map(t => [`${t.stock}|${t.entryDate}`, t]));
  for (const rg of ['trend', 'range']) {
    const hs = allHalf.filter(t => t.halved && t.halveRegime === rg);
    const pairs = hs.map(t => ({ h: t, b: idx.get(`${t.stock}|${t.entryDate}`) })).filter(x => x.b);
    if (!pairs.length) { console.log(`${rg}: 无样本`); continue; }
    const sumH = pairs.reduce((a, x) => a + x.h.pnl, 0), sumB = pairs.reduce((a, x) => a + x.b.pnl, 0);
    const winH = pairs.filter(x => x.h.pnl > 0).length, winB = pairs.filter(x => x.b.pnl > 0).length;
    const better = pairs.filter(x => x.h.pnl > x.b.pnl).length;
    out[`split_${rg}`] = { n: pairs.length, halfTotal: sumH, holdTotal: sumB, diff: sumH - sumB, halfWin: winH / pairs.length, holdWin: winB / pairs.length, halfBetterCount: better };
    console.log(`${rg === 'trend' ? '趋势票' : '震荡票'} ${pairs.length}笔:`);
    console.log(`  减半 总${sumH.toFixed(0)}元 每笔${(sumH / pairs.length).toFixed(0)} 胜率${pct(winH / pairs.length)}`);
    console.log(`  不减 总${sumB.toFixed(0)}元 每笔${(sumB / pairs.length).toFixed(0)} 胜率${pct(winB / pairs.length)}`);
    console.log(`  → 差额 ${(sumH - sumB) >= 0 ? '+' : ''}${(sumH - sumB).toFixed(0)}元 | 减半更优的占 ${better}/${pairs.length} (${pct(better / pairs.length)})`);
  }

  // ---------- Q3 阈值敏感性 ----------
  console.log('\n########## Q3 阈值敏感性(所有票) ##########');
  out.thresholds = {};
  for (const ru of [0.03, 0.05, 0.07, 0.10]) {
    const line = [];
    for (const fd of [0.01, 0.02, 0.03, 0.05]) {
      const m = metrics(run({ halfSell: true, runUpTh: ru, fadeTh: fd }));
      out.thresholds[`${ru}_${fd}`] = { total: m.totalPnl, mdd: m.mdd };
      line.push(`回落>${(fd * 100).toFixed(0)}%: ${(m.totalPnl - bm.totalPnl >= 0 ? '+' : '')}${(m.totalPnl - bm.totalPnl).toFixed(0)}`);
    }
    console.log(`涨幅>${(ru * 100).toFixed(0)}% | ${line.join(' | ')}`);
  }

  // ---------- 稳健性 ----------
  console.log('\n########## 稳健性(前后半段) ##########');
  const allDates = []; for (const s of stocks) for (const r of s.rows) allDates.push(r.date);
  allDates.sort(); const mid = allDates[Math.floor(allDates.length / 2)];
  console.log(`切分点 ${mid}`);
  for (const p of plans) {
    const all = run(p.o);
    const f = metrics(all.filter(t => t.entryDate < mid)), s2 = metrics(all.filter(t => t.entryDate >= mid));
    console.log(`${p.label}\n  前半 ${f.n}笔 每笔${f.exp.toFixed(0)}元 pf${f.pf.toFixed(2)} | 后半 ${s2.n}笔 每笔${s2.exp.toFixed(0)}元 pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_n.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ 明细写入 backtest/results_n.json');
})();
