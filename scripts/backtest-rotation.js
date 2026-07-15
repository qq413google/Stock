#!/usr/bin/env node
/**
 * 题材切换回测：历史上，哪些信号能提前预警「科技→防御」的板块轮动？
 *
 * 测的信号：
 *   ① 创业板/上证 相对强弱发散 — 创业板连续跑输上证 N 天
 *   ② 自选池宽度崩塌 — 科技股站上 MA20 的比例骤降
 *   ③ 量能集中度 — 科技股成交量占比萎缩
 *   ④ 科技连续下跌天数 — 连续 N 天净下跌
 *
 * 判断标准（"切换发生"）：
 *   当天起往后 5/10/20 天，科技池收益 < 防御池收益 → 切换成立
 *
 * 科技池：watchlist.json 中赛道属于 光通信/PCB/半导体/AI服务器/芯片/EDA/消费电子/面板 的
 * 防御池：硬编码 — 猪肉(牧原) 医药(恒瑞) 消费(海天) 公用事业(长江电力) 银行(招行)
 *
 * Usage: node backtest-rotation.js
 */

const fs = require('fs');
const path = require('path');
const wl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;

// 科技赛道
const TECH_TRACKS = new Set(['光通信','PCB','半导体','AI服务器','芯片','EDA','消费电子','面板','通信设备']);
// 防御标的（硬编码，不在 watchlist 里）
const DEFENSIVE = [
  { name: '牧原股份', secid: '0.002714' },
  { name: '恒瑞医药', secid: '1.600276' },
  { name: '海天味业', secid: '1.603288' },
  { name: '长江电力', secid: '1.600900' },
  { name: '招商银行', secid: '1.600036' },
];
const TECH = wl.filter(s => TECH_TRACKS.has(s.赛道));

async function getKl(secid) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=500`;
  for (let a = 0; a < 4; a++) {
    try {
      const k = await fetch(u).then(r => r.json());
      const rows = ((k.data && k.data.klines) || []).map(L => { const p = L.split(','); return { date: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5], amount: +p[6] }; });
      if (rows.length >= 120) return rows;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

const ma = (kl, i, n) => kl.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n;
const ret = (kl, i) => (kl[i].c - kl[i - 1].c) / kl[i - 1].c * 100;

// 构建所有个股的数据 map: { date: { aboveMA20, ret, vol } }
function buildDayMap(kl) {
  const m = {};
  for (let i = 60; i < kl.length; i++) {
    m[kl[i].date] = {
      aboveMA20: kl[i].c > ma(kl, i, 20),
      aboveMA60: kl[i].c > ma(kl, i, 60),
      ret: ret(kl, i),
      vol: kl[i].v,
    };
  }
  return m;
}

// 对一组股票，每天汇总
function poolDaily(pool, dayMaps) {
  // dayMaps: Map<secid, dateMap>
  const result = {};
  for (const s of pool) {
    const dm = dayMaps.get(s.secid);
    if (!dm) continue;
    for (const [date, d] of Object.entries(dm)) {
      if (!result[date]) result[date] = { cnt: 0, above20: 0, above60: 0, retSum: 0, volSum: 0, retCnt: 0 };
      const r = result[date];
      r.cnt++;
      if (d.aboveMA20) r.above20++;
      if (d.aboveMA60) r.above60++;
      r.retSum += d.ret;
      r.volSum += d.vol;
      r.retCnt++;
    }
  }
  return result;
}

function rotSignal(techDay, defDay, date) {
  // 信号①：创业板/上证 相对强弱（用科技池平均涨幅近似，因为大部分是创业板/深市）
  // 信号②：科技池 MA20 占比（宽度）
  // 信号③：科技池 vs 防御池宽度差值
  // 信号④：科技池连续下跌天数（用 retAvg < 0 累计）
  return techDay && defDay ? {
    techBreadth: techDay.above20 / techDay.cnt * 100,          // 科技宽度%
    defBreadth: defDay.above20 / defDay.cnt * 100,              // 防御宽度%
    breadthGap: (techDay.above20 / techDay.cnt - defDay.above20 / defDay.cnt) * 100, // 宽度差(科技-防御)
    techRet: techDay.retSum / techDay.retCnt,                   // 科技平均涨幅
    defRet: defDay.retSum / defDay.retCnt,                      // 防御平均涨幅
    techVol: techDay.volSum,
    defVol: defDay.volSum,
  } : null;
}

function fwdReturn(pool, dayMaps, date, days) {
  // 计算从 date 起持有 days 的等权平均收益
  // 找 date 在 K 线中的位置，取 Forward 收益
  const results = [];
  for (const s of pool) {
    const kl = dayMaps.get(s.secid + '_kl');
    if (!kl) continue;
    const idx = kl.findIndex(k => k.date === date);
    if (idx < 0 || idx + days >= kl.length) continue;
    const entry = kl[idx].c;
    const exit = kl[idx + days].c;
    results.push((exit - entry) / entry * 100);
  }
  return results.length ? results.reduce((a, b) => a + b, 0) / results.length : null;
}

function summ(arr) {
  const valid = arr.filter(x => x !== null && !isNaN(x));
  if (!valid.length) return 'n=0';
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const win = valid.filter(x => x > 0).length / valid.length * 100;
  return `n=${valid.length} 均值 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% 胜率 ${win.toFixed(0)}%`;
}

(async () => {
  console.log('加载数据中...');
  const allStocks = [...TECH, ...DEFENSIVE];
  const dayMaps = new Map(); // secid -> dateMap
  const klMaps = new Map();  // secid + '_kl' -> kl array

  for (const s of allStocks) {
    const kl = await getKl(s.secid);
    if (!kl) { console.log(`  ${s.name} 数据缺失，跳过`); continue; }
    dayMaps.set(s.secid, buildDayMap(kl));
    klMaps.set(s.secid + '_kl', kl);
    await new Promise(r => setTimeout(r, 150));
  }

  const techDaily = poolDaily(TECH, dayMaps);
  const defDaily = poolDaily(DEFENSIVE, dayMaps);

  // 找出共同日期
  const allDates = Object.keys(techDaily).filter(d => defDaily[d]).sort();
  console.log(`共同交易日: ${allDates.length} 天\n`);

  // ===== 信号后置研究 =====
  // 分类：信号日 → 后 5/10/20 天 科技 vs 防御 收益差
  const signals = { all: [], techBreadthHigh: [], techBreadthLow: [], gapWide: [], gapNarrow: [], gapNegative: [], techFall3d: [], techFall5d: [] };

  for (let i = 4; i < allDates.length; i++) {
    const d = allDates[i];
    const s = rotSignal(techDaily[d], defDaily[d], d);
    if (!s) continue;

    // Forward 收益差（科技 - 防御，负数 = 切换发生）
    const f5t = fwdReturn(TECH, klMaps, d, 5);
    const f5d = fwdReturn(DEFENSIVE, klMaps, d, 5);
    const f10t = fwdReturn(TECH, klMaps, d, 10);
    const f10d = fwdReturn(DEFENSIVE, klMaps, d, 10);
    const f20t = fwdReturn(TECH, klMaps, d, 20);
    const f20d = fwdReturn(DEFENSIVE, klMaps, d, 20);

    const diff5 = f5t !== null && f5d !== null ? f5t - f5d : null;
    const diff10 = f10t !== null && f10d !== null ? f10t - f10d : null;
    const diff20 = f20t !== null && f20d !== null ? f20t - f20d : null;

    const obj = { date: d, s, diff5, diff10, diff20 };
    signals.all.push(obj);

    // 分组
    if (s.techBreadth >= 60) signals.techBreadthHigh.push(obj);
    if (s.techBreadth < 40) signals.techBreadthLow.push(obj);
    if (s.breadthGap > 20) signals.gapWide.push(obj);
    if (s.breadthGap < 10) signals.gapNarrow.push(obj);
    if (s.breadthGap < 0) signals.gapNegative.push(obj);       // 防御宽度 > 科技宽度

    // 科技连续下跌天数（往前看）
    let fallDays = 0;
    for (let j = i; j >= 1; j--) {
      const prevS = rotSignal(techDaily[allDates[j]], defDaily[allDates[j]], allDates[j]);
      if (prevS && prevS.techRet < 0) fallDays++;
      else break;
    }
    if (fallDays >= 3) signals.techFall3d.push(obj);
    if (fallDays >= 5) signals.techFall5d.push(obj);
  }

  // ===== 输出 =====
  console.log('═══════════════════════════════════════════');
  console.log('  题材切换信号回测：科技 vs 防御收益差');
  console.log('  (差值为负 = 科技跑输防御 = 切换成立)');
  console.log('═══════════════════════════════════════════\n');

  const show = (label, arr, field) => {
    const vals = arr.map(x => x[field]).filter(v => v !== null && !isNaN(v));
    const neg = vals.filter(v => v < 0);
    console.log(`${label.padEnd(42)} ${summ(vals).padEnd(50)} 切换率 ${neg.length}/${vals.length}=${(neg.length/vals.length*100).toFixed(0)}%`);
  };

  console.log('【基准】所有交易日');
  show('  fwd5 科技-防御收益差', signals.all, 'diff5');
  show('  fwd10 科技-防御收益差', signals.all, 'diff10');
  show('  fwd20 科技-防御收益差', signals.all, 'diff20');

  console.log('\n━━━ 信号①：科技池宽度（站上MA20的股票占比）━━━');
  printGroup('科技宽度 >=60%（强势）', signals.techBreadthHigh);
  printGroup('科技宽度 <40%（弱势/可能切换）', signals.techBreadthLow);

  console.log('\n━━━ 信号②：科技-防御宽度差 ━━━');
  printGroup('宽度差 >20%（科技远强于防御）', signals.gapWide);
  printGroup('宽度差 <10%（差距缩小，临界）', signals.gapNarrow);
  printGroup('宽度差 <0（防御反超科技！🔴）', signals.gapNegative);

  console.log('\n━━━ 信号③：科技池连续下跌 ━━━');
  printGroup('连续下跌 >=3天', signals.techFall3d);
  printGroup('连续下跌 >=5天', signals.techFall5d);

  console.log('\n━━━ 最极端信号组合 ━━━');
  const combo = signals.all.filter(x =>
    x.s && x.s.techBreadth < 40 && x.s.breadthGap < 0
  );
  console.log(`「科技宽度<40% + 防御宽度>科技宽度」共 ${combo.length} 天`);
  show('  fwd5 科技-防御差', combo, 'diff5');
  show('  fwd10 科技-防御差', combo, 'diff10');
  show('  fwd20 科技-防御差', combo, 'diff20');

  // 合并信号：科技宽度<40% 或 连续下跌>=3天 或 宽度差<0
  const combinedSignal = signals.all.filter(x =>
    x.s && (x.s.techBreadth < 40 || x.s.breadthGap < 0)
  );
  // 对每个combined day，check 是否有 fall3d
  const fall3dMap = new Set();
  for (const x of combinedSignal) {
    let fd = 0;
    const idx = allDates.indexOf(x.date);
    for (let j = idx; j >= 1; j--) {
      const ps = rotSignal(techDaily[allDates[j]], defDaily[allDates[j]], allDates[j]);
      if (ps && ps.techRet < 0) fd++; else break;
    }
    if (fd >= 3) fall3dMap.add(x.date);
  }
  const withFall = combinedSignal.filter(x => fall3dMap.has(x.date));
  console.log(`\n「(科技宽度<40% 或 宽度差<0) + 连续下跌>=3天」共 ${withFall.length} 天`);
  show('  fwd5 科技-防御差', withFall, 'diff5');
  show('  fwd10 科技-防御差', withFall, 'diff10');
  show('  fwd20 科技-防御差', withFall, 'diff20');

  console.log('\n⚠️ 费未计入；未建模涨跌停；样本仅覆盖约2年。');
  console.log('结论：差值为负且切换率高 → 该信号有预警能力。');
})();

function printGroup(label, group) {
  console.log(`\n  ${label} (${group.length}天)`);
  const f5 = group.map(x => x.diff5).filter(v => v !== null && !isNaN(v));
  const f10 = group.map(x => x.diff10).filter(v => v !== null && !isNaN(v));
  const f20 = group.map(x => x.diff20).filter(v => v !== null && !isNaN(v));
  const neg5 = f5.filter(v => v < 0).length;
  const neg10 = f10.filter(v => v < 0).length;
  const neg20 = f20.filter(v => v < 0).length;

  const r5 = f5.length ? (f5.reduce((a,b)=>a+b,0)/f5.length) : null;
  const r10 = f10.length ? (f10.reduce((a,b)=>a+b,0)/f10.length) : null;
  const r20 = f20.length ? (f20.reduce((a,b)=>a+b,0)/f20.length) : null;

  if (r5 !== null) console.log(`    fwd5:  均值 ${r5>=0?'+':''}${r5.toFixed(2)}% 切换率 ${neg5}/${f5.length}=${(neg5/f5.length*100).toFixed(0)}%`);
  if (r10 !== null) console.log(`    fwd10: 均值 ${r10>=0?'+':''}${r10.toFixed(2)}% 切换率 ${neg10}/${f10.length}=${(neg10/f10.length*100).toFixed(0)}%`);
  if (r20 !== null) console.log(`    fwd20: 均值 ${r20>=0?'+':''}${r20.toFixed(2)}% 切换率 ${neg20}/${f20.length}=${(neg20/f20.length*100).toFixed(0)}%`);
}
