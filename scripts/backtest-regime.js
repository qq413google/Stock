#!/usr/bin/env node
/**
 * 行情过滤检验：在"完整策略(顺势回踩/突破)"基础上，按【信号当天大盘是否站上MA20】分组，
 * 看 market.js 式的行情过滤能否避开亏损段、能否救回样本外(前半段)的负期望。
 * 大盘尺子测两个：上证(与market.js一致) 和 创业板(自选池偏科技,更相关)。
 * 费按 0.30%。⚠️ 未建模涨跌停。
 * Usage: node backtest-regime.js
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
async function aboveMa20Map(secid) {
  const rows = await getKl(secid); const map = {};
  for (let i = 19; i < rows.length; i++) { const ma20 = rows.slice(i - 19, i + 1).reduce((a, b) => a + b.c, 0) / 20; map[rows[i].date] = rows[i].c > ma20; }
  return map;
}
const ma = (kl, i, n) => kl.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n;
const volMa = (kl, i, n) => kl.slice(i - n, i).reduce((a, b) => a + b.v, 0) / n;
const breakout = (kl, i) => { const pct = (kl[i].c - kl[i - 1].c) / kl[i - 1].c * 100; const hi20 = Math.max(...kl.slice(i - 20, i).map(x => x.h)); return kl[i].c > hi20 && kl[i].v > volMa(kl, i, 5) * 1.2 && pct <= 5 && pct > 0; };
const pullback = (kl, i) => kl[i].c > ma(kl, i, 20) && kl[i].l <= ma(kl, i, 10) * 1.005 && kl[i].c > ma(kl, i, 10) && kl[i].v < volMa(kl, i, 5);
const trend = (kl, i) => kl[i].c > ma(kl, i, 60);

function buildBreadth(data) {
  const cnt = {};
  for (const kl of data) for (let i = 19; i < kl.length; i++) { const d = kl[i].date; if (!cnt[d]) cnt[d] = [0, 0]; cnt[d][1]++; if (kl[i].c > ma(kl, i, 20)) cnt[d][0]++; }
  const m = {}; for (const d in cnt) m[d] = cnt[d][0] / cnt[d][1] * 100;
  return m;
}
function collect(data, shMap, cyMap, brMap) {
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
      trades.push({ raw: (exit - entry) / entry * 100, half: i < mid ? 1 : 2, sh: shMap[date], cy: cyMap[date], br: brMap[date] });
      i = j + 1;
    }
  }
  return trades;
}
function summ(trades) {
  if (!trades.length) return '0笔';
  const rets = trades.map(t => t.raw - FEE);
  const wins = rets.filter(x => x > 0), losses = rets.filter(x => x <= 0);
  const exp = rets.reduce((a, b) => a + b, 0) / rets.length;
  const avgW = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgL = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  return `${rets.length}笔 胜率${(wins.length / rets.length * 100).toFixed(0)}% 盈亏比${avgL ? (avgW / avgL).toFixed(2) : '∞'} 期望${exp >= 0 ? '+' : ''}${exp.toFixed(2)}% 累计${rets.reduce((a, b) => a + b, 0).toFixed(0)}%`;
}

(async () => {
  const shMap = await aboveMa20Map('1.000001');
  const cyMap = await aboveMa20Map('0.399006');
  const data = [];
  for (const s of wl) { data.push(await getKl(s.secid)); await new Promise(r => setTimeout(r, 150)); }
  const valid = data.filter(d => d.length >= 120);
  const brMap = buildBreadth(valid);
  const trades = collect(valid, shMap, cyMap, brMap);
  console.log(`=== 行情过滤检验 (${trades.length}笔, 费0.30%) ===\n`);
  console.log('全部:', summ(trades));
  console.log('\n--- 按信号日 上证 vs MA20 ---');
  console.log(' 上证在MA20上(顺风):', summ(trades.filter(t => t.sh === true)));
  console.log(' 上证在MA20下(逆风):', summ(trades.filter(t => t.sh === false)));
  console.log('\n--- 按信号日 创业板 vs MA20 ---');
  console.log(' 创业板在MA20上:', summ(trades.filter(t => t.cy === true)));
  console.log(' 创业板在MA20下:', summ(trades.filter(t => t.cy === false)));
  console.log('\n--- 亏损的前半段, 拆行情(能否被过滤掉) ---');
  console.log(' 前半段·上证上:', summ(trades.filter(t => t.half === 1 && t.sh === true)));
  console.log(' 前半段·上证下:', summ(trades.filter(t => t.half === 1 && t.sh === false)));
  console.log('\n--- 过滤后策略(只在上证>MA20做) 分半段 ---');
  console.log(' 前半段:', summ(trades.filter(t => t.sh === true && t.half === 1)));
  console.log(' 后半段:', summ(trades.filter(t => t.sh === true && t.half === 2)));
  console.log('\n--- 过滤后策略(只在创业板>MA20做) 分半段 ---');
  console.log(' 前半段:', summ(trades.filter(t => t.cy === true && t.half === 1)));
  console.log(' 后半段:', summ(trades.filter(t => t.cy === true && t.half === 2)));
  console.log('\n--- 按信号日 自选池宽度(>MA20占比) ---');
  console.log(' 池宽度>=50%(顺风):', summ(trades.filter(t => t.br != null && t.br >= 50)));
  console.log(' 池宽度<50%(逆风):', summ(trades.filter(t => t.br != null && t.br < 50)));
  console.log(' 池宽度>=60%(强):', summ(trades.filter(t => t.br != null && t.br >= 60)));
  console.log('--- 过滤后(只在池宽度>=50%做) 分半段 ---');
  console.log(' 前半段:', summ(trades.filter(t => t.br != null && t.br >= 50 && t.half === 1)));
  console.log(' 后半段:', summ(trades.filter(t => t.br != null && t.br >= 50 && t.half === 2)));
  console.log('\n⚠️ 未建模涨跌停;板块普涨度(market.js另一条件)历史不可得,此处只用指数vsMA20近似。');
})();
