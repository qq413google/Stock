#!/usr/bin/env node
/**
 * 回测引擎底座 (lib.js)
 * - 拉取日K(最长1200条≈4.7年) 与 资金流(最长120条≈最近120交易日, end翻页无效)
 * - 计算 MA5/10/20/60, RSI14, MACD, KDJ, 量比
 * - 按日对齐、通用交易模拟器、指标统计
 * 说明: 资金流硬上限120交易日, 故"依赖资金流的研究"统一跑在最近120交易日窗口;
 *       纯价格研究(C/B价格部分)用完整1200天K线, 样本更长更稳。
 */
const RISK_YUAN = 750;          // 单笔风险=账户1.5% (5万)
const ACCOUNT = 50000;
const PRICE_CAP = 180;          // ≤180元价格约束
const HARD_STOP = 0.92;         // 单股硬顶 -8%
const COST_RATE = 0.0015;       // 往返交易成本 0.15% (risk-management.md 十一节)

function applyCost(entry, exit, shares) {
  const notional = (entry + exit) / 2 * shares;
  return notional * COST_RATE;
}

function sma(arr, i, p) {
  if (i - p + 1 < 0) return NaN;
  let s = 0; for (let k = i - p + 1; k <= i; k++) s += arr[k];
  return s / p;
}
function emaSeries(arr, p) {
  const k = 2 / (p + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

// 计算全部技术指标, 写入每行
function computeIndicators(rows) {
  const c = rows.map(r => r.c);
  const h = rows.map(r => r.h);
  const l = rows.map(r => r.l);
  const v = rows.map(r => r.v);
  const n = rows.length;
  const ema12 = emaSeries(c, 12), ema26 = emaSeries(c, 26);
  const dif = c.map((_, i) => ema12[i] - ema26[i]);
  const dea = emaSeries(dif, 9);
  // RSI14 (Wilder-ish 简单均值)
  const gains = [], losses = [];
  for (let i = 1; i < n; i++) { const ch = c[i] - c[i - 1]; gains.push(ch > 0 ? ch : 0); losses.push(ch < 0 ? -ch : 0); }
  // KDJ
  let K = 50, D = 50;
  for (let i = 0; i < n; i++) {
    const h9 = Math.max(...h.slice(Math.max(0, i - 8), i + 1));
    const l9 = Math.min(...l.slice(Math.max(0, i - 8), i + 1));
    const rsv = h9 === l9 ? 50 : (c[i] - l9) / (h9 - l9) * 100;
    K = (2 / 3) * K + (1 / 3) * rsv; D = (2 / 3) * D + (1 / 3) * K;
  }
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    r.ma5 = sma(c, i, 5); r.ma10 = sma(c, i, 10); r.ma20 = sma(c, i, 20); r.ma60 = sma(c, i, 60);
    r.rsi = (() => {
      if (i < 14) return NaN;
      const ag = gains.slice(i - 14, i).reduce((a, b) => a + b, 0) / 14;
      const al = losses.slice(i - 14, i).reduce((a, b) => a + b, 0) / 14;
      return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    })();
    r.dif = dif[i]; r.dea = dea[i]; r.macd = 2 * (dif[i] - dea[i]);
    r.kdjK = K; // 末值近似; 如需逐日可改递推存数组(此处KDJ仅用作超买阈值, 末日足够)
    r.volMa5 = sma(v, i, 5);
    r.volRatio = r.volMa5 ? v[i] / r.volMa5 : 1;
  }
  return rows;
}

async function getJson(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const d = await (await fetch(url)).json();
      if (d && (d.data || d.klines)) return d;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 2000 * (t + 1)));
  }
  return null;
}
async function fetchKline(secid, lmt = 1200) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${lmt}`;
  const d = await getJson(url);
  const ks = d?.data?.klines || [];
  return ks.map(s => { const p = s.split(','); return { date: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5], amt: +p[6] }; });
}
async function fetchFlow(secid, lmt = 120) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=${lmt}&klt=101`;
  const d = await getJson(url);
  const ks = d?.data?.klines || [];
  return ks.map(s => {
    const p = s.split(',');
    return { date: p[0], main: +p[1] / 1e8, small: +p[2] / 1e8, medium: +p[3] / 1e8, large: +p[4] / 1e8, superL: +p[5] / 1e8, mainRatio: +p[6], smallRatio: +p[7] };
  });
}

// ---------- 文件缓存 ----------
const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'backtest');
function cachePath(secid, type) { return path.join(CACHE_DIR, `${secid.replace(/\./g, '_')}_${type}.json`); }
function readCache(secid, type) { try { return JSON.parse(fs.readFileSync(cachePath(secid, type), 'utf8')); } catch { return null; } }
function writeCache(secid, type, data) { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cachePath(secid, type), JSON.stringify(data)); } catch { /* ignore */ } }

// 合并: 取K线全量算指标, 再截取"有资金流的最后N日"窗口
async function loadStock(secid, { klineLmt = 600, flowLmt = 120, clipToFlow = true, noCache = false } = {}) {
  let klines = null, flows = null;
  if (!noCache) { klines = readCache(secid, 'kline'); flows = readCache(secid, 'flow'); }
  // 缓存命中条件: 数量够用(≥请求的90%) + kline有数据
  if (!klines || !flows || klines.length < klineLmt * 0.9 || flows.length < flowLmt * 0.9 || klines.length === 0) {
    [klines, flows] = await Promise.all([fetchKline(secid, klineLmt), fetchFlow(secid, flowLmt)]);
    if (klines && klines.length > 0) writeCache(secid, 'kline', klines);
    if (flows && flows.length > 0) writeCache(secid, 'flow', flows);
  }
  computeIndicators(klines);
  const fmap = new Map(flows.map(f => [f.date, f]));
  let rows = klines.map(k => {
    const f = fmap.get(k.date);
    return f ? { ...k, ...f } : { ...k, main: NaN, superL: NaN, large: NaN, medium: NaN, small: NaN, mainRatio: NaN };
  });
  if (clipToFlow) {
    // 找到第一个有资金流的索引, 截到末尾
    const start = rows.findIndex(r => !isNaN(r.main));
    rows = start >= 0 ? rows.slice(start) : [];
  }
  return rows;
}

// 通用交易模拟器: 给定策略函数 buy(r,i)->{kind,stop,entry}|null, 单股一次一仓, 风险反推仓位
function simulate(rows, buy, opts = {}) {
  const maxHold = opts.maxHold || 60;
  const useCap = opts.useCap !== false; // 默认启用≤180约束
  const trades = [];
  let inPos = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (inPos) {
      let stop = inPos.stop;
      const profitPct = (r.c - inPos.entry) / inPos.entry;
      if (profitPct >= 0.05) stop = Math.max(stop, inPos.entry);
      if (profitPct >= 0.05) stop = Math.max(stop, inPos.highest * 0.93);
      inPos.highest = Math.max(inPos.highest, r.c);
      let exit = null, reason = '';
      if (inPos.takeProfit && r.c >= inPos.takeProfit) { exit = inPos.takeProfit; reason = 'target'; }
      else if (r.l <= stop) { exit = stop; reason = 'stop'; }
      else if (r.c <= inPos.entry * HARD_STOP) { exit = inPos.entry * HARD_STOP; reason = 'hardstop'; }
      else if (profitPct >= 0.05 && r.c <= stop) { exit = stop; reason = 'trail'; }
      else if (i - inPos.i >= maxHold) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const pnl = (exit - inPos.entry) * inPos.shares;
        const pnlPct = (exit - inPos.entry) / inPos.entry;
        trades.push({ stock: opts.name, entryDate: rows[inPos.i].date, exitDate: r.date, entry: inPos.entry, exit, shares: inPos.shares, pnl, pnlPct, days: i - inPos.i, kind: inPos.kind, reason });
        inPos = null;
      }
      continue;
    }
    const sig = buy(rows, i);
    if (!sig) continue;
    if (useCap && sig.entry > PRICE_CAP) continue;
    let stop = sig.stop;
    if (!(stop > 0) || stop >= sig.entry) continue;
    stop = Math.max(stop, sig.entry * HARD_STOP);
    const stopDist = sig.entry - stop;
    if (stopDist <= 0) continue;
    let shares;
    if (sig.entry <= PRICE_CAP) {
      shares = Math.floor(RISK_YUAN / stopDist);
      shares = Math.min(shares, Math.floor(18000 / sig.entry));
      shares = Math.max(shares - (shares % 100), 100);
    } else {
      shares = 100;
    }
    if (shares < 100) continue;
    inPos = { i, entry: sig.entry, stop, shares, kind: sig.kind, highest: sig.entry, takeProfit: sig.takeProfit || null };
  }
  return trades;
}

// 组合级并发模拟: 按真实日期推进, maxConcurrent=3, 先平后开, 扣交易成本
function simulatePortfolio(stocks, buyFn, opts = {}) {
  const MAX_CONCURRENT = opts.maxConcurrent || 3;
  const MAX_HOLD = opts.maxHold || 60;
  const USE_CAP = opts.useCap !== false;

  // 1. 建立统一日历
  const allDates = new Set();
  for (const s of stocks) for (const r of s.rows) allDates.add(r.date);
  const dates = Array.from(allDates).sort();

  // 2. 每只股票: name + rows + date→rowIndex 映射
  const stockMaps = stocks.map(s => ({
    name: s.name,
    rows: s.rows,
    map: new Map(s.rows.map((r, i) => [r.date, i])),
  }));

  // 3. 状态
  const heldSet = new Set();
  let openPositions = [];
  const trades = [];
  let missedByCapacity = 0;
  let peakConcurrent = 0;

  for (const date of dates) {
    // 3a. 先处理平仓
    const surviving = [];
    const exitedToday = new Set(); // 与 simulate() 对齐: 当天平仓的股票, 当天不允许再开仓(需等下一交易日)
    for (const pos of openPositions) {
      const sm = stockMaps.find(s => s.name === pos.stock);
      if (!sm) { surviving.push(pos); continue; }
      const idx = sm.map.get(date);
      if (idx === undefined) { surviving.push(pos); continue; }
      const r = sm.rows[idx];
      // 与 simulate() 对齐: 先用"昨日为止"的highest算今日stop, 再把今日收盘计入highest(避免用今日高点抬今日自己的止损)
      const profitPct = (r.c - pos.entry) / pos.entry;
      let effectiveStop = pos.stop;
      if (profitPct >= 0.05) effectiveStop = Math.max(effectiveStop, pos.entry);
      if (profitPct >= 0.05) effectiveStop = Math.max(effectiveStop, pos.highest * 0.93);
      pos.highest = Math.max(pos.highest, r.c);
      let exit = null, reason = '';
      if (pos.takeProfit && r.c >= pos.takeProfit) { exit = pos.takeProfit; reason = 'target'; }
      else if (r.l <= effectiveStop) { exit = effectiveStop; reason = 'stop'; }
      else if (r.c <= pos.entry * HARD_STOP) { exit = pos.entry * HARD_STOP; reason = 'hardstop'; }
      else if (profitPct >= 0.05 && r.c <= effectiveStop) { exit = effectiveStop; reason = 'trail'; }
      else if (idx - pos.entryIdx >= MAX_HOLD) { exit = r.c; reason = 'timeout'; }
      if (exit !== null) {
        const cost = applyCost(pos.entry, exit, pos.shares);
        const pnl = (exit - pos.entry) * pos.shares - cost;
        const pnlPct = pnl / (pos.entry * pos.shares);
        trades.push({ stock: pos.stock, entryDate: pos.entryDate, exitDate: date, entry: pos.entry,
          exit, shares: pos.shares, pnl, pnlPct, kind: pos.kind, reason, cost });
        heldSet.delete(pos.stock);
        exitedToday.add(pos.stock);
      } else { surviving.push(pos); }
    }
    openPositions = surviving;
    peakConcurrent = Math.max(peakConcurrent, openPositions.length);

    // 3b. 收集全部候选信号, 按优先级排序后占名额
    const candidates = [];
    for (const sm of stockMaps) {
      if (heldSet.has(sm.name)) continue;
      if (exitedToday.has(sm.name)) continue; // 当天刚平仓, 不能同日再开(对齐 simulate())
      const idx = sm.map.get(date);
      if (idx === undefined) continue;
      const sig = buyFn(sm.rows, idx);
      if (!sig) continue;
      if (USE_CAP && sig.entry > PRICE_CAP) continue;
      candidates.push({ sm, idx, sig });
    }
    // 优先级排序: 传priorityFn则用它, 不传则保持原始列表顺序(向后兼容 results_v2)
    if (opts.priorityFn) {
      candidates.sort((a, b) => opts.priorityFn(b.sm.rows, b.idx) - opts.priorityFn(a.sm.rows, a.idx));
    }
    for (const { sm, idx, sig } of candidates) {
      if (openPositions.length >= MAX_CONCURRENT) { missedByCapacity++; continue; }
      let stop = sig.stop;
      if (!(stop > 0) || stop >= sig.entry) continue;
      stop = Math.max(stop, sig.entry * HARD_STOP);
      const stopDist = sig.entry - stop;
      if (stopDist <= 0) continue;
      let shares;
      if (sig.entry <= PRICE_CAP) {
        shares = Math.floor(RISK_YUAN / stopDist);
        shares = Math.min(shares, Math.floor(18000 / sig.entry));
        shares = Math.max(shares - (shares % 100), 100);
      } else {
        shares = 100;
      }
      if (shares < 100) continue;
      openPositions.push({ stock: sm.name, entry: sig.entry, stop, shares, kind: sig.kind,
        highest: sig.entry, takeProfit: sig.takeProfit || null, entryDate: date, entryIdx: idx });
      heldSet.add(sm.name);
    }
  }

  // 4. 窗口末尾强制平仓
  for (const pos of openPositions) {
    const sm = stockMaps.find(s => s.name === pos.stock);
    if (!sm) continue;
    const r = sm.rows[sm.rows.length - 1];
    const cost = applyCost(pos.entry, r.c, pos.shares);
    const pnl = (r.c - pos.entry) * pos.shares - cost;
    const pnlPct = pnl / (pos.entry * pos.shares);
    trades.push({ stock: pos.stock, entryDate: pos.entryDate, exitDate: r.date, entry: pos.entry,
      exit: r.c, shares: pos.shares, pnl, pnlPct, kind: pos.kind, reason: 'window_end', cost });
  }

  return { trades, missedByCapacity, peakConcurrent };
}

function metrics(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: NaN, avgWin: NaN, avgLoss: NaN, exp: NaN, expPct: NaN, pf: NaN };
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const exp = trades.reduce((a, t) => a + t.pnl, 0) / n;
  const expPct = trades.reduce((a, t) => a + t.pnlPct, 0) / n;
  const winRate = wins.length / n;
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss ? grossWin / grossLoss : Infinity;
  // 资金曲线(等权, 忽略并发)最大回撤
  let eq = ACCOUNT, peak = ACCOUNT, mdd = 0;
  for (const t of trades) { eq += t.pnl; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  return { n, winRate, avgWin, avgLoss, exp, expPct, pf, mdd, totalPnl: trades.reduce((a, t) => a + t.pnl, 0) };
}

function fwdReturn(rows, i, k) {
  if (i + k >= rows.length) return null;
  return rows[i + k].c / rows[i].c - 1;
}

function pool(items, fn, conc = 6) {
  const out = []; let idx = 0;
  return new Promise(res => {
    const worker = async () => {
      while (idx < items.length) {
        const j = idx++; out.push(await fn(items[j], j));
      }
      res(out);
    };
    for (let w = 0; w < conc; w++) worker();
  });
}

module.exports = { loadStock, simulate, simulatePortfolio, metrics, fwdReturn, pool, computeIndicators, RISK_YUAN, ACCOUNT, PRICE_CAP, HARD_STOP, COST_RATE, applyCost, fetchKline, fetchFlow };
