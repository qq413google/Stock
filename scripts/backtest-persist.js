#!/usr/bin/env node
/**
 * 趋势持续性 regime 检验：用创业板指(科技风格尺)构造多种"持续性"过滤,
 * 看能否识别并避开亏损的前半段(2024-06~2025-06绞肉市)。
 * 对比基线(不过滤)。费0.30%。
 *
 * ⚠️ 探索性：全部在同一 2024-2026 窗口上找规律,天然有过拟合风险;
 *    且持续性=滞后指标,转折点必失灵。不是能预判行情的银弹。
 * Usage: node backtest-persist.js
 */
const fs = require('fs');
const path = require('path');
const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const FEE = 0.30;

async function getKl(secid) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=500`;
  for (let a = 0; a < 4; a++) {
    try { const k = await fetch(u).then(r => r.json()); const rows = ((k.data && k.data.klines) || []).map(L => { const p = L.split(','); return { date: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] }; }); if (rows.length >= 120) return rows; } catch (e) { }
    await new Promise(r => setTimeout(r, 500));
  }
  return [];
}
const ma = (kl, i, n) => kl.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n;
const volMa = (kl, i, n) => kl.slice(i - n, i).reduce((a, b) => a + b.v, 0) / n;
const breakout = (kl, i) => { const pct = (kl[i].c - kl[i - 1].c) / kl[i - 1].c * 100; const hi20 = Math.max(...kl.slice(i - 20, i).map(x => x.h)); return kl[i].c > hi20 && kl[i].v > volMa(kl, i, 5) * 1.2 && pct <= 5 && pct > 0; };
const pullback = (kl, i) => kl[i].c > ma(kl, i, 20) && kl[i].l <= ma(kl, i, 10) * 1.005 && kl[i].c > ma(kl, i, 10) && kl[i].v < volMa(kl, i, 5);
const trend = (kl, i) => kl[i].c > ma(kl, i, 60);

// ADX(14) Wilder
function adxSeries(rows) {
  const n = rows.length, P = 14;
  const tr = new Array(n).fill(0), pdm = new Array(n).fill(0), ndm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h = rows[i].h, l = rows[i].l, pc = rows[i - 1].c, ph = rows[i - 1].h, pl = rows[i - 1].l;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - ph, dn = pl - l;
    pdm[i] = (up > dn && up > 0) ? up : 0;
    ndm[i] = (dn > up && dn > 0) ? dn : 0;
  }
  const str = new Array(n).fill(0), sp = new Array(n).fill(0), sn = new Array(n).fill(0), dx = new Array(n).fill(0), adx = new Array(n).fill(null);
  let a = 0, b = 0, c = 0;
  for (let i = 1; i <= P && i < n; i++) { a += tr[i]; b += pdm[i]; c += ndm[i]; }
  if (n > P) { str[P] = a; sp[P] = b; sn[P] = c; }
  for (let i = P + 1; i < n; i++) { str[i] = str[i - 1] - str[i - 1] / P + tr[i]; sp[i] = sp[i - 1] - sp[i - 1] / P + pdm[i]; sn[i] = sn[i - 1] - sn[i - 1] / P + ndm[i]; }
  for (let i = P; i < n; i++) { const pdi = str[i] ? 100 * sp[i] / str[i] : 0, ndi = str[i] ? 100 * sn[i] / str[i] : 0; dx[i] = (pdi + ndi) ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0; }
  if (n > 2 * P) { let s = 0; for (let i = P + 1; i <= 2 * P; i++) s += dx[i]; adx[2 * P] = s / P; for (let i = 2 * P + 1; i < n; i++) adx[i] = (adx[i - 1] * (P - 1) + dx[i]) / P; }
  return adx;
}
// Hurst(差分法): std(price[t+lag]-price[t]) ~ lag^H, H=log-log斜率
function hurst(x) {
  const lags = [], tau = [];
  for (let lag = 2; lag <= 20; lag++) { let s = 0, cnt = 0; for (let i = lag; i < x.length; i++) { const d = x[i] - x[i - lag]; s += d * d; cnt++; } if (cnt) { tau.push(Math.sqrt(s / cnt)); lags.push(lag); } }
  const lx = lags.map(Math.log), ly = tau.map(v => Math.log(v || 1e-9)), N = lx.length;
  const mx = lx.reduce((p, q) => p + q, 0) / N, my = ly.reduce((p, q) => p + q, 0) / N;
  let num = 0, den = 0; for (let i = 0; i < N; i++) { num += (lx[i] - mx) * (ly[i] - my); den += (lx[i] - mx) ** 2; }
  return den ? num / den : 0.5;
}
// 创业板每日 regime 特征
function cyFeatures(rows) {
  const m = {}; let consec = 0;
  const adx = adxSeries(rows);
  const closes = rows.map(r => r.c);
  for (let i = 0; i < rows.length; i++) {
    if (i < 60) { consec = 0; continue; }
    const c = rows[i].c, m20 = ma(rows, i, 20), m20p = ma(rows, i - 5, 20), m60 = ma(rows, i, 60);
    consec = c > m20 ? consec + 1 : 0;
    let sumAbs = 0; for (let k = i - 19; k <= i; k++) sumAbs += Math.abs(rows[k].c - rows[k - 1].c);
    const er = sumAbs ? Math.abs(rows[i].c - rows[i - 20].c) / sumAbs : 0;
    m[rows[i].date] = { consec, slopeUp: m20 > m20p, aboveMA60: c > m60, er, adx: adx[i], hurst: i >= 100 ? hurst(closes.slice(i - 99, i + 1)) : null };
  }
  return m;
}
function collect(data, cyMap) {
  const trades = [];
  for (const kl of data) {
    if (kl.length < 120) continue;
    const mid = Math.floor(kl.length / 2);
    let i = 60;
    while (i < kl.length - 1) {
      if (!(breakout(kl, i) || pullback(kl, i)) || !trend(kl, i)) { i++; continue; }
      const entry = kl[i].c, date = kl[i].date;
      let exit = null, j;
      for (j = i + 1; j < Math.min(i + 31, kl.length); j++) {
        if (kl[j].l <= entry * 0.92) { exit = entry * 0.92; break; }
        if (kl[j].c < ma(kl, j, 10)) { exit = kl[j].c; break; }
      }
      if (exit === null) { j = Math.min(i + 30, kl.length - 1); exit = kl[j].c; }
      trades.push({ raw: (exit - entry) / entry * 100, half: i < mid ? 1 : 2, cy: cyMap[date] });
      i = j + 1;
    }
  }
  return trades;
}
function exp(ts) { return ts.length ? ts.reduce((a, b) => a + b.raw - FEE, 0) / ts.length : 0; }
function line(label, ts) {
  const f = ts.filter(t => t.half === 1), b = ts.filter(t => t.half === 2);
  const fmt = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  console.log(`${label.padEnd(22)} | 全${String(ts.length).padStart(3)}笔 ${fmt(exp(ts))} | 前半${String(f.length).padStart(3)} ${fmt(exp(f))} | 后半${String(b.length).padStart(3)} ${fmt(exp(b))}`);
}

(async () => {
  const cyRows = await getKl('0.399006');
  const cyMap = cyFeatures(cyRows);
  const data = [];
  for (const s of wl) { data.push(await getKl(s.secid)); await new Promise(r => setTimeout(r, 150)); }
  const all = collect(data.filter(d => d.length >= 120), cyMap);
  const ok = all.filter(t => t.cy); // 有creg特征的
  console.log(`=== 趋势持续性 regime 检验 (创业板尺, 费0.30%, ${ok.length}笔) ===`);
  console.log('目标:看哪个能把"前半段"从亏(-0.58%)拉到不亏\n');
  line('基线(不过滤)', ok);
  line('创业板站上MA20', ok.filter(t => t.cy.consec >= 1));
  line('连续≥5日站上MA20', ok.filter(t => t.cy.consec >= 5));
  line('连续≥10日站上MA20', ok.filter(t => t.cy.consec >= 10));
  line('MA20向上(斜率)', ok.filter(t => t.cy.slopeUp));
  line('站上MA60', ok.filter(t => t.cy.aboveMA60));
  line('效率比≥0.3(趋势干净)', ok.filter(t => t.cy.er >= 0.3));
  line('连10日MA20+斜率向上', ok.filter(t => t.cy.consec >= 10 && t.cy.slopeUp));
  line('站MA60+效率比≥0.3', ok.filter(t => t.cy.aboveMA60 && t.cy.er >= 0.3));
  console.log('  -- 借鉴业界指标(ADX / Hurst) --');
  line('ADX>25(趋势)', ok.filter(t => t.cy.adx != null && t.cy.adx > 25));
  line('ADX<20(震荡,对照)', ok.filter(t => t.cy.adx != null && t.cy.adx < 20));
  line('Hurst>0.5(趋势)', ok.filter(t => t.cy.hurst != null && t.cy.hurst > 0.5));
  line('Hurst>0.55(强趋势)', ok.filter(t => t.cy.hurst != null && t.cy.hurst > 0.55));
  line('Hurst<0.5(均值回归,对照)', ok.filter(t => t.cy.hurst != null && t.cy.hurst < 0.5));
  line('ADX>25且Hurst>0.5', ok.filter(t => t.cy.adx != null && t.cy.adx > 25 && t.cy.hurst != null && t.cy.hurst > 0.5));
  console.log('\n⚠️ 同一窗口找规律=过拟合风险;持续性/ADX/Hurst 都是滞后指标,转折必失灵。前半段能否被拉正才是关键看点。');
})();
