#!/usr/bin/env node
/**
 * 研究P：移动止损该不该含 MA10？无条件 MA10 有多大危害？ (2026-08-14)
 *
 * 起因：京东方 08-14 在仅亏 1.68% 时被止损，用户追问"才亏1个多点就出货合理吗"。
 *       查代码发现 arm-positions.js 的移动止损是 `trailPx = MA10`(**无条件**)，
 *       浮盈≥5%时才叠加 成本/峰值×0.93。而**所有回测(K/L/M/N)的 baseline 里根本没有 MA10**：
 *           if (浮盈>=5%) { stop = max(stop, 成本); stop = max(stop, 峰值*0.93); }
 *       京东方 everProfit=false(峰值浮盈仅+0.5%)，故保本/峰值两条都没生效，
 *       **唯一起作用的就是那条没有回测背书的 MA10**，把止损从 5.76(-3.0%) 收紧到 5.85(-1.5%)，
 *       容错砍半。该股当日最低 5.83 从未跌破 5.76 —— 按已验证口径今天不该出局。
 *       此为 2026-08-11 去掉"浮盈≥5%"门槛(为修加仓后浮盈稀释问题)时引入的副作用。
 *
 * 问题：
 *   Q1 移动止损加 MA10 到底有没有用？(A vs B)
 *   Q2 "无条件 MA10"(当前实盘) 比"有盈利门槛的 MA10" 差多少？(B vs C)
 *   Q3 只用 MA10 呢？(D) —— 规则第五节1 的字面写法就是"跌破MA10才走"
 *
 * 四种移动止损口径（其余条件完全一致，只改这一处）：
 *   A base        浮盈≥5% → max(原stop, 成本, 峰值×0.93)      ← 回测baseline，已被K/M/N使用
 *   B ma10_gated  浮盈≥5% → max(原stop, 成本, 峰值×0.93, MA10) ← 加MA10但保留门槛
 *   C ma10_always 无条件 max(原stop, MA10); 浮盈≥5%再叠加另两条 ← **当前实盘(疑似bug)**
 *   D ma10_only   浮盈≥5% → max(原stop, MA10)                  ← 规则第五节1字面写法
 *
 * 口径与研究K/M/N一致：纯价格进场、1200日、0.15%成本、-8%硬顶、≤180上限、750元反推手数。
 * 不含加仓/减半(隔离变量，只看移动止损口径本身)。
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

function simulate(rows, { mode = 'A', maxHold = 60, name = '' } = {}) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos) {
      const profitPct = (r.c - pos.entry) / pos.entry;
      let stop = pos.stop;
      const m10 = r.ma10 > 0 ? r.ma10 : 0;
      // ---- 四种移动止损口径 ----
      if (mode === 'A') {
        if (profitPct >= 0.05) { stop = Math.max(stop, pos.entry, pos.highest * 0.93); }
      } else if (mode === 'B') {
        if (profitPct >= 0.05) { stop = Math.max(stop, pos.entry, pos.highest * 0.93, m10); }
      } else if (mode === 'C') {
        if (m10 > 0 && r.c > m10) stop = Math.max(stop, m10);          // 无条件(仅要求价在MA10上方,同实盘)
        if (profitPct >= 0.05) { stop = Math.max(stop, pos.entry, pos.highest * 0.93); }
      } else if (mode === 'D') {
        if (profitPct >= 0.05 && m10 > 0) stop = Math.max(stop, m10);
      }
      pos.highest = Math.max(pos.highest, r.c);

      let exit = null, reason = '';
      if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= pos.entry * HARD_STOP) { exit = pos.entry * HARD_STOP; reason = 'hardstop'; }
      else if (i - pos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const fee = applyCost(pos.entry, exit, pos.shares);
        const pnl = (exit - pos.entry) * pos.shares - fee;
        const pnlPct = (exit - pos.entry) / pos.entry;
        trades.push({
          stock: name, entryDate: rows[pos.i].date, exitDate: r.date, pnl, pnlPct, reason,
          days: i - pos.i, kind: pos.kind,
          everProfit5: pos.highest >= pos.entry * 1.05,     // 持仓期间是否曾浮盈5%
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
    pos = { i, entry: sig.entry, shares, stop, kind: sig.kind, highest: sig.entry };
  }
  return trades;
}

const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  console.log('=== 研究P：移动止损口径 —— MA10 该不该在里面 ===\n');
  const loaded = await pool(wl, async s => {
    try { const rows = await loadStock(s.secid, { klineLmt: 1200, flowLmt: 120, clipToFlow: false }); return rows.length > 120 ? { name: s.name, rows } : null; } catch { return null; }
  }, 4);
  const stocks = loaded.filter(Boolean);
  console.log(`加载 ${stocks.length}/${wl.length} 只 | ${stocks.reduce((a, s) => a + s.rows.length, 0)} 股票日\n`);

  const run = m => { let a = []; for (const s of stocks) a = a.concat(simulate(s.rows, { mode: m, name: s.name })); return a; };
  const plans = [
    { k: 'A', label: 'A 回测baseline: 浮盈≥5%→max(成本,峰值×0.93)  【已验证】' },
    { k: 'B', label: 'B baseline+MA10(保留盈利门槛)' },
    { k: 'C', label: 'C 无条件MA10+baseline  【当前实盘,疑似bug】' },
    { k: 'D', label: 'D 只用MA10(浮盈≥5%后)  【规则第五节1字面】' },
  ];

  const out = {};
  console.log('########## 主对比 ##########');
  const res = {};
  for (const p of plans) {
    const all = run(p.k); const m = metrics(all);
    res[p.k] = { all, m };
    const stopped = all.filter(t => t.reason === 'stop');
    const neverProfit = all.filter(t => !t.everProfit5);
    const avgDays = all.reduce((a, t) => a + t.days, 0) / all.length;
    out[p.k] = { label: p.label, n: m.n, winRate: m.winRate, exp: m.exp, pf: m.pf, mdd: m.mdd, total: m.totalPnl, stopRate: stopped.length / m.n, avgDays };
    console.log(`${p.label}\n  ${m.n}笔 | 胜率${pct(m.winRate)} | 每笔${m.exp.toFixed(0)}元 | pf${m.pf.toFixed(2)} | mdd${(m.mdd * 100).toFixed(1)}% | 总${m.totalPnl.toFixed(0)}元`);
    console.log(`  止损出场${pct(stopped.length / m.n)} | 平均持有${avgDays.toFixed(1)}天 | 从未浮盈5%的${neverProfit.length}笔(${pct(neverProfit.length / m.n)})`);
  }

  console.log('\n########## 差额 (vs A 已验证baseline) ##########');
  for (const p of plans.slice(1)) {
    const d = res[p.k].m.totalPnl - res.A.m.totalPnl;
    console.log(`${p.k}: ${d >= 0 ? '+' : ''}${d.toFixed(0)}元 | 回撤 ${(res[p.k].m.mdd * 100).toFixed(1)}% vs ${(res.A.m.mdd * 100).toFixed(1)}%`);
  }

  // 关键: 只看"从未浮盈5%"的那批(京东方就属于这类) —— 无条件MA10只对这批生效
  console.log('\n########## 关键切片: 从未浮盈≥5% 的交易 (京东方属于这类) ##########');
  const idxA = new Map(res.A.all.map(t => [`${t.stock}|${t.entryDate}`, t]));
  for (const k of ['B', 'C', 'D']) {
    const pairs = res[k].all.filter(t => !t.everProfit5).map(t => ({ x: t, a: idxA.get(`${t.stock}|${t.entryDate}`) })).filter(p => p.a);
    if (!pairs.length) { console.log(`${k}: 无配对样本`); continue; }
    const sx = pairs.reduce((a, p) => a + p.x.pnl, 0), sa = pairs.reduce((a, p) => a + p.a.pnl, 0);
    const worse = pairs.filter(p => p.x.pnl < p.a.pnl).length;
    out[`slice_${k}`] = { n: pairs.length, total: sx, baseTotal: sa, diff: sx - sa, worseRate: worse / pairs.length };
    console.log(`${k} — ${pairs.length}笔: ${sx.toFixed(0)}元 vs A的${sa.toFixed(0)}元 → 差额${sx - sa >= 0 ? '+' : ''}${(sx - sa).toFixed(0)} | 比A更差的占${pct(worse / pairs.length)}`);
  }

  console.log('\n########## 稳健性(前后半段) ##########');
  const ad = []; for (const s of stocks) for (const r of s.rows) ad.push(r.date);
  ad.sort(); const mid = ad[Math.floor(ad.length / 2)];
  console.log(`切分点 ${mid}`);
  out.robustness = {};
  for (const p of plans) {
    const all = res[p.k].all;
    const f = metrics(all.filter(t => t.entryDate < mid)), s2 = metrics(all.filter(t => t.entryDate >= mid));
    out.robustness[p.k] = { first: { n: f.n, exp: f.exp, pf: f.pf }, second: { n: s2.n, exp: s2.exp, pf: s2.pf } };
    console.log(`${p.k} 前半 ${f.n}笔 每笔${f.exp.toFixed(0)}元 pf${f.pf.toFixed(2)} | 后半 ${s2.n}笔 每笔${s2.exp.toFixed(0)}元 pf${s2.pf.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'results_p.json'), JSON.stringify(out, null, 2));
  console.log('\n✅ backtest/results_p.json');
})();
