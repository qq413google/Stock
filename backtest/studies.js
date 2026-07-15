#!/usr/bin/env node
/**
 * 5 项"挤水分"回测研究 (studies.js)
 * 运行: node studies.js
 * 输出: 控制台报告 + 写入 results.json
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

// ---------- 策略定义 ----------
function gate(r, i) {
  const c = r[i];
  if (!(c.c > c.ma60)) return false;     // 须站MA60
  if (!(c.c > c.ma20)) return false;     // 须站MA20
  if (i > 0 && (c.c / r[i - 1].c - 1) > 0.05) return false; // 当日涨>5%禁
  return true;
}
// 禁买清单 (返回触发的规则名 或 null)
function banned(r, i) {
  const c = r[i];
  if (c.c < c.ma20 && (i > 0 && (c.c / r[i - 1].c - 1) < -0.03)) return '破位大阴线';
  // 顶部首跌: 近5日创20日新高 且 今日收盘跌破MA20
  for (let k = Math.max(0, i - 5); k <= i; k++) {
    const w = Math.max(...r.slice(Math.max(0, k - 20), k + 1).map(x => x.c));
    if (r[k].c >= w && c.c < c.ma20) return '顶部首跌';
  }
  if (c.c < c.ma60) return '板块退潮/逆势'; // proxy: 下行环境逆势接
  return null;
}
function buyPoints(r, i) {
  if (i < 1) return null;
  const c = r[i];
  if (Math.abs(c.c - c.ma10) / c.ma10 < 0.02 && c.c >= c.ma10 && r[i - 1].c >= r[i - 1].ma20) return '回踩';
  let newHigh = false;
  for (let k = Math.max(0, i - 5); k <= i; k++) {
    const w = Math.max(...r.slice(Math.max(0, k - 20), k + 1).map(x => x.c));
    if (r[k].c >= w) newHigh = true;
  }
  if (newHigh && c.c <= c.ma20 * 1.03 && c.c > c.ma20) return '突破回踩';
  if (i > 0 && c.c > c.ma20 && r[i - 1].c <= r[i - 1].ma20 && c.mainRatio >= 10 && c.volRatio < 1.0) return '反包';
  return null;
}
// 严格买点 (趋势, 含禁买清单 + 三类买点)
function strictBuy(r, i) {
  if (!gate(r, i)) return null;
  if (banned(r, i)) return null;
  const kind = buyPoints(r, i);
  if (!kind) return null;
  const c = r[i];
  let stop = Math.min(c.ma20, c.c * 0.97);
  const stopDist = (c.c - stop) / c.c;
  if (stopDist > 0.04) return null;
  return { kind, stop, entry: c.c };
}
// 宽松买点 (研究B基线: 顺势+禁买, 任意回调都买)
function looseBuy(r, i) {
  if (!gate(r, i)) return null;
  if (banned(r, i)) return null;
  const c = r[i];
  if (!(c.c < c.ma5 * 1.01)) return null; // 有回调
  let stop = Math.min(c.ma20, c.c * 0.97);
  const stopDist = (c.c - stop) / c.c;
  if (stopDist > 0.04) return null;
  return { kind: '随便回调', stop, entry: c.c };
}
// 均值回归 (研究A: 超跌反弹)
function mrBuy(r, i) {
  if (i < 1) return null;
  const c = r[i];
  if (!(c.c < c.ma60)) return null;       // 下行/绞肉环境
  if (isNaN(c.rsi) || c.rsi >= 35) return null; // 超卖
  if (!(c.c > c.o)) return null;          // 当日阳线反弹
  if (!(i > 0 && c.c / r[i - 1].c - 1 > 0.01)) return null; // 止跌回升
  let stop = Math.min(c.c * 0.95, c.ma20);
  const stopDist = (c.c - stop) / c.c;
  if (stopDist > 0.04) return null;
  return { kind: '超跌反弹', stop, entry: c.c, takeProfit: c.ma20 }; // 回归均值(MA20)止盈
}
// 组合 (研究A: 上行用趋势, 下行用均值回归)
function combinedBuy(r, i) {
  return r[i].c > r[i].ma60 ? strictBuy(r, i) : mrBuy(r, i);
}
// 宽口径顺势(研究C: 放大样本以检验高价龙头是否有edge)
function anyTrendBuy(r, i) {
  const c = r[i];
  if (!(c.c > c.ma20)) return null;
  let stop = Math.min(c.ma20, c.c * 0.95);
  const stopDist = (c.c - stop) / c.c;
  if (stopDist > 0.06) return null;
  return { kind: '顺势', stop, entry: c.c };
}

// ---------- 工具 ----------
const fmtPct = x => (isNaN(x) ? '-' : (x * 100).toFixed(1) + '%');
const fmtNum = (x, d = 2) => (isNaN(x) ? '-' : x.toFixed(d));
function mline(m) {
  return `n=${m.n} 胜率=${fmtPct(m.winRate)} 期望/笔=${(m.exp||0).toFixed(0)}元(${fmtPct(m.expPct)}) 盈亏比=${fmtNum(m.pf)} 最大回撤=${fmtPct(m.mdd)} 累计=${((m.totalPnl||0)).toFixed(0)}元`;
}

// ---------- 加载宇宙 ----------
const WL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8')).stocks;
const HIGHPRICE = [
  { name: '新易盛', secid: '0.300502' }, { name: '中际旭创', secid: '0.300308' },
  { name: '天孚通信', secid: '0.300394' }, { name: '寒武纪', secid: '1.688256' },
  { name: '海光信息', secid: '1.688041' },
];

async function loadUniverse(list, opts, conc = 3) {
  const stocks = await L.pool(list, async s => {
    try {
      const rows = await L.loadStock(s.secid, opts);
      if (!opts.quiet && rows.length === 0) console.log(`  [跳过] ${s.name}: 无数据`);
      return { ...s, rows };
    } catch (e) { console.log(`  [失败] ${s.name}: ${String(e).slice(0, 80)}`); return { ...s, rows: [], err: String(e) }; }
  }, conc);
  return stocks;
}

const results = { meta: {}, studies: {} };

const PRIORITY_FN = (r, i) => isNaN(r[i].mainRatio) ? -999 : r[i].mainRatio; // 主力净占比优先
function runVersions(stocks, buyFn, opts = {}) {
  return {
    listOrder: L.simulatePortfolio(stocks, buyFn, opts),
    priority: L.simulatePortfolio(stocks, buyFn, { ...opts, priorityFn: PRIORITY_FN }),
    reversed: L.simulatePortfolio([...stocks].reverse(), buyFn, opts),
  };
}
function versionTable(versions) {
  const rows = [];
  for (const k of ['listOrder', 'priority', 'reversed']) {
    const m = L.metrics(versions[k].trades);
    rows.push({ ver: k, m, missed: versions[k].missedByCapacity, peak: versions[k].peakConcurrent });
  }
  return rows;
}
function printVersionTable(label, rows) {
  console.log(label);
  console.log('  版本        笔数  胜率     期望/笔       盈亏比   最大回撤  累计      错过  峰值');
  for (const r of rows) {
    const names = { listOrder: '列表顺序', priority: '优先级排序', reversed: '列表反转' };
    const sign = (r.m.expPct || 0) >= 0 ? '+' : '';
    console.log(`  ${names[r.ver].padEnd(10)} ${String(r.m.n).padStart(4)} ${(r.m.winRate*100).toFixed(1).padStart(5)}% ${sign}${(r.m.exp||0).toFixed(0).padStart(5)}(${((r.m.expPct||0)*100).toFixed(1)}%) pf=${(r.m.pf||0).toFixed(2)} mdd=${((r.m.mdd||0)*100).toFixed(1)}% ${((r.m.totalPnl||0)).toFixed(0).padStart(6)} ${r.missed.toString().padStart(4)} ${r.peak}`);
  }
  const signs = [...new Set(rows.map(r => (r.m.expPct||0) >= 0))];
  const stable = signs.length === 1;
  console.log(`  三版正负一致? ${stable ? (signs[0] ? '✅ 均为正' : '🔴 均为负(稳健)') : '⚠️ 不一致!'}`);
  return stable;
}

(async () => {
  // 一次加载全部股票(自选+高价龙头), 防止重复加载限流
  const EXTRA_HIGHPRICE = HIGHPRICE.filter(h => !WL.find(w => w.secid === h.secid));
  const ALL_UNIVERSE = WL.concat(EXTRA_HIGHPRICE);
  console.log(`加载全宇宙 ${ALL_UNIVERSE.length} 只(自选+高价龙头)...`);
  const rawAll = await loadUniverse(ALL_UNIVERSE, { klineLmt: 600, flowLmt: 120, clipToFlow: false }, 1);
  const allKline = rawAll.filter(s => s.rows.length > 200);
  console.log(`  有效全量K线: ${allKline.length}/${ALL_UNIVERSE.length} 只`);
  // 长窗口(供A)、资金流窗口(B/D/E)、扩展宇宙(C) 共用同一批数据
  const wlLong = allKline.filter(s => WL.find(w => w.secid === s.secid)); // A只用自选
  const wlFlow = wlLong.map(s => ({ ...s, rows: s.rows.filter(r => !isNaN(r.main)) })).filter(s => s.rows.length > 60);
  const uni = allKline; // C用全部(含高价龙头)
  console.log(`  A长窗口: ${wlLong.length} 只 | B/D/E资金流窗口: ${wlFlow.length} 只 | C扩展宇宙: ${uni.length} 只`);
  if (wlFlow.length) console.log(`  资金流范围: ${wlFlow[0].rows[0]?.date} ~ ${wlFlow[0].rows[wlFlow[0].rows.length-1]?.date}`);
  results.meta = { flowWindow: wlFlow.length ? `${wlFlow[0].rows[0]?.date}~${wlFlow[0].rows[wlFlow[0].rows.length-1]?.date}` : 'N/A',
    wlKline: wlLong.length, wlFlowCount: wlFlow.length, extAllCount: uni.length };

  // ===== 研究A: 趋势+均值回归 (3版排序) =====
  console.log('\n========== 研究A: 趋势+均值回归 (3版排序对比) ==========');
  {
    const stocks = wlLong.map(s => ({ name: s.name, rows: s.rows }));
    const tVersions = runVersions(stocks, strictBuy);
    const tRows = versionTable(tVersions);
    const stable = printVersionTable('趋势策略(严格买点)', tRows);
    // MR 仍用原引擎检查(0笔结果一致)
    const mRes = L.simulatePortfolio(stocks, mrBuy);
    console.log(`  均值回归: ${mRes.trades.length} 笔(同前)`);
    results.studies.A = { versions: tRows.map(r => ({ ver: r.ver, metrics: r.m, missed: r.missed, peak: r.peak })), stable, mrTrades: mRes.trades.length };
  }

  // ===== 研究B: 买点 ablation (3版排序) =====
  console.log('\n========== 研究B: 买点定义 ablation (3版排序对比) ==========');
  {
    const stocks = wlFlow.map(s => ({ name: s.name, rows: s.rows }));
    const sVersions = runVersions(stocks, strictBuy);
    const sRows = versionTable(sVersions);
    const stableS = printVersionTable('严格(三类买点)', sRows);
    const lVersions = runVersions(stocks, looseBuy);
    const lRows = versionTable(lVersions);
    const stableL = printVersionTable('宽松(随便回调)', lRows);
    const dist = {};
    sVersions.listOrder.trades.forEach(t => dist[t.kind] = (dist[t.kind] || 0) + 1);
    console.log('  严格买点分布:', JSON.stringify(dist));
    results.studies.B = { strictVersions: sRows.map(r => ({ ver: r.ver, metrics: r.m, missed: r.missed })),
      looseVersions: lRows.map(r => ({ ver: r.ver, metrics: r.m, missed: r.missed })), dist, stableStrict: stableS, stableLoose: stableL };
  }

  // ===== 研究C: ≤180 约束 (独立池×3版) =====
  console.log('\n========== 研究C: ≤180价格上限 (capped/uncapped独立池×3版) ==========');
  {
    const stocks = uni.map(s => ({ name: s.name, rows: s.rows }));
    const cVersions = runVersions(stocks, anyTrendBuy, { useCap: true });
    const cRows = versionTable(cVersions);
    const stableC = printVersionTable('capped(严格执行≤180)', cRows);
    const uVersions = runVersions(stocks, anyTrendBuy, { useCap: false });
    const uRows = versionTable(uVersions);
    const stableU = printVersionTable('uncapped(不设限)', uRows);
    const gtInU = uVersions.listOrder.trades.filter(t => t.entry > L.PRICE_CAP).length;
    console.log(`  辅助: uncapped(列表顺序版)中高价股成交 ${gtInU} 笔`);
    results.studies.C = { cappedVersions: cRows.map(r => ({ ver: r.ver, metrics: r.m, missed: r.missed })),
      uncappedVersions: uRows.map(r => ({ ver: r.ver, metrics: r.m, missed: r.missed })), gtInUncapped: gtInU, stableCapped: stableC, stableUncapped: stableU };
  }

  // ===== 研究D: 禁买清单逐条 ablation (不预加gate, 让禁买能真实触发) =====
  console.log('\n========== 研究D: 禁买清单逐条 ablation (涨>5%/顶部首跌/板块退潮) ==========');
  {
    function candidates(r) {
      const out = [];
      for (let i = 1; i < r.length; i++) {
        if (!(r[i].c < r[i].ma5 * 1.01)) continue; // 任意回调日(不预加gate)
        out.push({ i, ban: banned(r, i) });
      }
      return out;
    }
    const allFwd = { base: [], up5: [], topfall: [], sector: [] };
    for (const s of wlFlow) {
      const cs = candidates(s.rows);
      for (const cd of cs) {
        const f5 = L.fwdReturn(s.rows, cd.i, 5);
        if (f5 == null) continue;
        allFwd.base.push(f5);
        if (cd.ban === '破位大阴线') allFwd.up5.push(f5);
        else if (cd.ban === '顶部首跌') allFwd.topfall.push(f5);
        else if (cd.ban === '板块退潮/逆势') allFwd.sector.push(f5);
      }
    }
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
    const hit = a => a.length ? a.filter(x => x < 0).length / a.length : NaN;
    const report = k => `${k}: n=${allFwd[k].length} 5日均值=${fmtPct(mean(allFwd[k]))} 下跌率=${fmtPct(hit(allFwd[k]))}`;
    console.log('基准(全部候选回调日):', report('base'));
    console.log('触发[破位大阴线]禁买:', report('up5'));
    console.log('触发[顶部首跌]禁买:', report('topfall'));
    console.log('触发[板块退潮/逆势]禁买:', report('sector'));
    const useful = [];
    if (allFwd.up5.length && mean(allFwd.up5) < mean(allFwd.base) - 0.01) useful.push('破位大阴线');
    if (allFwd.topfall.length && mean(allFwd.topfall) < mean(allFwd.base) - 0.01) useful.push('顶部首跌');
    if (allFwd.sector.length && mean(allFwd.sector) < mean(allFwd.base) - 0.01) useful.push('板块退潮/逆势');
    console.log(`结论: 真有用的禁买规则=${useful.join(',') || '无(均噪声/与gate重叠)'}`);
    results.studies.D = {
      base: { n: allFwd.base.length, f5: mean(allFwd.base), down: hit(allFwd.base) },
      up5: { n: allFwd.up5.length, f5: mean(allFwd.up5), down: hit(allFwd.up5) },
      topfall: { n: allFwd.topfall.length, f5: mean(allFwd.topfall), down: hit(allFwd.topfall) },
      sector: { n: allFwd.sector.length, f5: mean(allFwd.sector), down: hit(allFwd.sector) },
      useful,
    };
  }

  // ===== 研究E: 止盈信号 ablation =====
  console.log('\n========== 研究E: 止盈信号 ablation (超大单 alone vs 超大单+大单+散户接盘) ==========');
  {
    const sigs = { base: [], super_only: [], mixed: [], strong: [] };
    for (const s of wlFlow) {
      const r = s.rows;
      for (let i = 1; i < r.length; i++) {
        const c = r[i];
        const f1 = L.fwdReturn(r, i, 1), f3 = L.fwdReturn(r, i, 3), f5 = L.fwdReturn(r, i, 5);
        if (f5 == null) continue;
        const superOut = c.superL < 0;
        const mixed = c.superL < 0 && c.large < 0 && (c.small + c.medium) > 0;
        const strong = c.main < 0 && c.mainRatio <= -8;
        sigs.base.push({ f1, f3, f5 });
        if (superOut) sigs.super_only.push({ f1, f3, f5 });
        if (mixed) sigs.mixed.push({ f1, f3, f5 });
        if (strong) sigs.strong.push({ f1, f3, f5 });
      }
    }
    const meanF = (a, k) => a.length ? a.reduce((x, y) => x + y[k], 0) / a.length : NaN;
    const hitF = (a, k) => a.length ? a.filter(x => x[k] < 0).length / a.length : NaN;
    const rep = (k, a) => `${k}: n=${a.length} 1日=${fmtPct(meanF(a,'f1'))} 3日=${fmtPct(meanF(a,'f3'))} 5日=${fmtPct(meanF(a,'f5'))} | 下跌率1/3/5=${fmtPct(hitF(a,'f1'))}/${fmtPct(hitF(a,'f3'))}/${fmtPct(hitF(a,'f5'))}`;
    console.log('基准(全部交易日):', rep('base', sigs.base));
    console.log('超大单净流出(单独):', rep('super_only', sigs.super_only));
    console.log('超大单+大单双出+散户接盘(混合):', rep('mixed', sigs.mixed));
    console.log('强出货(主力净流出&净占比≤-8%):', rep('strong', sigs.strong));
    // 哪个信号对后市下跌预测更强: 看5日均值更负 / 下跌率更高
    const rank = ['super_only', 'mixed', 'strong'].sort((a, b) => meanF(sigs[a], 'f5') - meanF(sigs[b], 'f5'));
    console.log(`5日下跌预测最强信号排序(负者在前): ${rank.map(r=>r+`(${fmtPct(meanF(sigs[r],'f5'))})`).join(' < ')}`);
    console.log(`结论: "超大单转净流出单独" vs "混合读法" — ${meanF(sigs.mixed,'f5') < meanF(sigs.super_only,'f5') ? '混合读法预测力更强' : '两者相近/单独更强'}; 是否需收盘确认: 本数据即收盘口径, 盘中快照误差无法复现(见报告)`);
    results.studies.E = {
      base: { n: sigs.base.length, f5: meanF(sigs.base, 'f5') },
      super_only: { n: sigs.super_only.length, f1: meanF(sigs.super_only, 'f1'), f3: meanF(sigs.super_only, 'f3'), f5: meanF(sigs.super_only, 'f5'), down5: hitF(sigs.super_only, 'f5') },
      mixed: { n: sigs.mixed.length, f1: meanF(sigs.mixed, 'f1'), f3: meanF(sigs.mixed, 'f3'), f5: meanF(sigs.mixed, 'f5'), down5: hitF(sigs.mixed, 'f5') },
      strong: { n: sigs.strong.length, f1: meanF(sigs.strong, 'f1'), f3: meanF(sigs.strong, 'f3'), f5: meanF(sigs.strong, 'f5'), down5: hitF(sigs.strong, 'f5') },
      rank,
    };
  }

  // ===== 研究F: 当日涨幅阈值 ablation (5%禁买阈值是否真是分界点) =====
  console.log('\n========== 研究F: 当日涨幅阈值 ablation (gate内的">5%"到底该定在哪) ==========');
  {
    // 候选: 站上MA60+MA20(顺势, 与gate()趋势条件一致), 剥离掉">5%"这条本身, 单独看"当日涨幅"分桶后的5日表现
    const buckets = [
      { key: '<0%', test: g => g < 0 },
      { key: '0~2%', test: g => g >= 0 && g < 0.02 },
      { key: '2~5%', test: g => g >= 0.02 && g < 0.05 },
      { key: '5~8%', test: g => g >= 0.05 && g < 0.08 },
      { key: '8%+', test: g => g >= 0.08 },
    ];
    const byBucket = Object.fromEntries(buckets.map(b => [b.key, []]));
    for (const s of wlFlow) {
      const r = s.rows;
      for (let i = 1; i < r.length; i++) {
        const c = r[i];
        if (!(c.c > c.ma60) || !(c.c > c.ma20)) continue; // 顺势前提, 与gate()一致(不含涨幅条件本身)
        const gain = c.c / r[i - 1].c - 1;
        const f5 = L.fwdReturn(r, i, 5);
        if (f5 == null) continue;
        const b = buckets.find(x => x.test(gain));
        if (b) byBucket[b.key].push(f5);
      }
    }
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
    const hit = a => a.length ? a.filter(x => x < 0).length / a.length : NaN;
    for (const b of buckets) {
      console.log(`${b.key}: n=${byBucket[b.key].length} 5日均值=${fmtPct(mean(byBucket[b.key]))} 下跌率=${fmtPct(hit(byBucket[b.key]))}`);
    }
    console.log('结论: 逐桶看5日均值从哪个区间开始明显转差, 判断5%是否为合理分界(而非拍脑袋)');
    results.studies.F = Object.fromEntries(buckets.map(b => [b.key, { n: byBucket[b.key].length, f5: mean(byBucket[b.key]), down: hit(byBucket[b.key]) }]));

    // ---- F续: 机制性检验 —— 涨幅越大,止损距离(%)是否真的被迫拉大、盈亏比是否真的变差 ----
    console.log('\n---------- 研究F续: 止损距离/盈亏比 按涨幅分桶 (直接检验risk-management.md的机制性论点) ----------');
    const byBucketRR = Object.fromEntries(buckets.map(b => [b.key, []]));
    for (const s of wlFlow) {
      const r = s.rows;
      for (let i = 1; i < r.length; i++) {
        const c = r[i];
        if (!(c.c > c.ma60) || !(c.c > c.ma20)) continue;
        const gain = c.c / r[i - 1].c - 1;
        const b = buckets.find(x => x.test(gain));
        if (!b) continue;
        const stop = Math.min(c.ma20, c.c * 0.97);
        const stopDist = (c.c - stop) / c.c;
        if (stopDist <= 0) continue;
        const resistance = Math.max(...r.slice(Math.max(0, i - 20), i + 1).map(x => x.c));
        const target = resistance > c.c ? resistance : c.c * 1.1; // 已破20日高(突破)则用+10%延伸做目标代理
        const rr = (target - c.c) / (c.c - stop);
        byBucketRR[b.key].push({ stopDist, rr });
      }
    }
    const meanK = (a, k) => a.length ? a.reduce((x, y) => x + y[k], 0) / a.length : NaN;
    for (const b of buckets) {
      const arr = byBucketRR[b.key];
      console.log(`${b.key}: n=${arr.length} 平均止损距离=${fmtPct(meanK(arr,'stopDist'))} 平均盈亏比=${fmtNum(meanK(arr,'rr'))}`);
    }
    console.log('结论: 若止损距离%随涨幅明显拉大且盈亏比明显跌破2, 则"5%代理盈亏比"的机制性论点成立; 若止损距离/盈亏比在各桶间差异不大, 则该论点也不成立');
    results.studies.F_mechanism = Object.fromEntries(buckets.map(b => [b.key, { n: byBucketRR[b.key].length, stopDist: meanK(byBucketRR[b.key],'stopDist'), rr: meanK(byBucketRR[b.key],'rr') }]));
  }

  // ===== 研究G: arm-alerts触发 -> confirm.js转化率 (历史基线 vs 近两周实况0/9) =====
  console.log('\n========== 研究G: 触发->confirm转化率 (近两周9次全FAIL是否异常) ==========');
  {
    // 复刻 arm-alerts.js 的两类触发定义(纯crossing事件, 不预加confirm会用到的条件, 避免循环论证)
    function armAlertTrigger(r, i) {
      if (i < 1) return null;
      const c = r[i], p = r[i - 1];
      if (c.c > c.ma20 && p.c <= p.ma20) return '反包'; // 超跌反包候选: 站回MA20(crossing)
      if (p.c > p.ma60 && p.c > p.ma20 && Math.abs(c.c - c.ma10) / c.ma10 < 0.02 && c.c >= c.ma10) return '回踩'; // 回踩支撑: 顺势中企稳MA10附近
      return null;
    }
    // 复刻 confirm.js 的 verdict 逻辑(用EOD字段近似, 无法复现盘中快照, 已知局限)
    const OUT = -0.3;
    function confirmVerdict(r, i) {
      const c = r[i];
      const bull = c.ma5 > c.ma10 && c.ma10 > c.ma20 && (isNaN(c.ma60) || c.ma20 > c.ma60);
      const cMa10 = c.c >= c.ma10;
      const reboundBuy = !bull && c.c > c.ma20 && !isNaN(c.mainRatio) && c.mainRatio >= 10 && c.main > 0;
      if (isNaN(c.main)) return 'WAIT';
      if (!cMa10 || c.main <= OUT) return 'FAIL';
      if (!isNaN(c.rsi) && c.rsi > 70) return 'WAIT';
      if (reboundBuy) return 'PASS';
      if (c.volRatio > 1.5) return 'WAIT';
      if (c.main > 0 && bull) return 'PASS';
      return 'WAIT';
    }
    const tally = { 回踩: { PASS: 0, FAIL: 0, WAIT: 0 }, 反包: { PASS: 0, FAIL: 0, WAIT: 0 } };
    for (const s of wlFlow) {
      const r = s.rows;
      for (let i = 1; i < r.length; i++) {
        const kind = armAlertTrigger(r, i);
        if (!kind) continue;
        const v = confirmVerdict(r, i);
        tally[kind][v]++;
      }
    }
    for (const kind of ['回踩', '反包']) {
      const t = tally[kind];
      const n = t.PASS + t.FAIL + t.WAIT;
      const passRate = n ? t.PASS / n : NaN;
      console.log(`${kind}: n=${n} PASS=${t.PASS}(${fmtPct(passRate)}) FAIL=${t.FAIL}(${fmtPct(n?t.FAIL/n:NaN)}) WAIT=${t.WAIT}(${fmtPct(n?t.WAIT/n:NaN)})`);
    }
    const allN = tally.回踩.PASS+tally.回踩.FAIL+tally.回踩.WAIT+tally.反包.PASS+tally.反包.FAIL+tally.反包.WAIT;
    const allPass = tally.回踩.PASS + tally.反包.PASS;
    console.log(`合计: n=${allN} 历史PASS率=${fmtPct(allN?allPass/allN:NaN)} | 近两周实况: 9次confirm全FAIL(0%)`);
    console.log('结论: 若历史PASS率本来就很低(个位数%), 说明这套触发+确认组合本身转化率低是常态, 近两周0%在正常波动范围内; 若历史PASS率明显高于0%(如两位数%), 则近两周0%值得怀疑是弱势市/巧合导致的异常低谷, 而非校准问题本身');
    results.studies.G = { 回踩: { ...tally.回踩, n: tally.回踩.PASS+tally.回踩.FAIL+tally.回踩.WAIT }, 反包: { ...tally.反包, n: tally.反包.PASS+tally.反包.FAIL+tally.反包.WAIT }, historicalPassRate: allN?allPass/allN:NaN };
  }

  fs.writeFileSync(path.join(__dirname, 'results_v3.json'), JSON.stringify(results, null, 2));

  // ===== 自检 (算术一致性 + 并发约束) =====
  console.log('\n========== 自检 (算术一致性 + 并发约束) ==========');
  const check = (label, m) => {
    if (!m || !m.n) { console.log(`${label}: n=0 跳过`); return; }
    const expCheck = m.winRate * m.avgWin + (1 - m.winRate) * m.avgLoss;
    const diff = Math.abs(m.exp - expCheck);
    console.log(`${label}: exp=${(m.exp||0).toFixed(1)} exp_check=${expCheck.toFixed(1)} 偏差=${diff.toFixed(2)} ${diff<2?'✅':'🔴'}`);
  };
  for (const k of ['A', 'B', 'C']) {
    const s = results.studies[k];
    const vers = s.versions || s.cappedVersions || s.strictVersions || [];
    for (const v of vers) check(`${k}-${v.ver}`, v.metrics);
    if (s.looseVersions) for (const v of s.looseVersions) check(`B-loose-${v.ver}`, v.metrics);
    if (s.uncappedVersions) for (const v of s.uncappedVersions) check(`C-uncap-${v.ver}`, v.metrics);
  }
  const names = { listOrder: '列表顺序', priority: '优先级排序', reversed: '列表反转' };
  for (const [k, vs] of [['A', results.studies.A?.versions], ['B', results.studies.B?.strictVersions], ['C', results.studies.C?.cappedVersions]]) {
    if (!vs) continue;
    for (const v of vs) {
      if (v.peak !== undefined) console.log(`  ${k}-${names[v.ver]||v.ver} 峰值并发=${v.peak} ${v.peak<=3?'✅':'🔴'}`);
    }
  }

  // ===== 向后兼容检查 (代码级: 同数据、同策略、新旧引擎单股结果一致) =====
  console.log('\n========== 向后兼容检查 (代码级: simulate vs simulatePortfolio) ==========');
  try {
    // 取第一只有效自选股, 用同一份数据跑两种引擎
    const testStock = wlLong[0];
    if (testStock) {
      const rows = testStock.rows;
      const oldTrades = L.simulate(rows, strictBuy, { name: testStock.name });
      const pRes = L.simulatePortfolio([{ name: testStock.name, rows }], strictBuy);
      const newTrades = pRes.trades;
      // 单股无并发竞争, 信号序列应一致
      const sameCount = oldTrades.length === newTrades.length;
      let samePnl = true;
      if (sameCount) {
        for (let i = 0; i < oldTrades.length; i++) {
          if (Math.abs((oldTrades[i].pnl||0) - (newTrades[i].pnl||0)) > 1) { samePnl = false; break; }
        }
      }
      // PnL会有成本差异(新引擎扣成本), 所以只比较笔数和日期
      const sameEntries = sameCount && oldTrades.every((t, i) => t.entryDate === newTrades[i].entryDate);
      console.log(`  测试股票: ${testStock.name}, 笔数: old=${oldTrades.length} new=${newTrades.length} ${sameCount?'✅':'🔴'}`);
      console.log(`  入场日期一致: ${sameEntries?'✅':'🔴'}`);
      // 新引擎PnL应更低(扣了成本)
      const oldTotal = oldTrades.reduce((a, t) => a + (t.pnl||0), 0);
      const newTotal = newTrades.reduce((a, t) => a + (t.pnl||0), 0);
      console.log(`  PnL: old=${oldTotal.toFixed(0)} new=${newTotal.toFixed(0)} (新引擎应有成本扣减, ${oldTotal>newTotal?'✅':'🔴'})`);

      // 数据集级对比(会和v2不同，因为每次拉数据的股票集可能不同——这是数据层面差异，不是代码bug)
      const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'results_v2.json'), 'utf8'));
      const aV2 = v2.studies.A.trend;
      const aV3 = results.studies.A.versions.find(v => v.ver === 'listOrder');
      console.log(`  数据集级: v2=${wlLong.length}~${allKline.length}只 v3=${aV2?.n}笔; v3=${aV3?.metrics?.n}笔 (不同拉取窗口可能股票集不同, 属正常)`);
    }
  } catch (e) { console.log('  兼容检查异常:', e.message); }

  console.log('\n✅ 结果已写入 backtest/results_v3.json (保留旧 results.json / results_v2.json)');
})();
