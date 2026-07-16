#!/usr/bin/env node
/**
 * 回踩买点三项确认（供 tasks/check-alerts.ps1 在触发时自动调用）。
 * 复用 flow.js 单日 fflow 接口 + calc.js kline 算法，不引入新字段。
 * 三项：① 主力当日净流入 ② 缩量(健康回踩) ③ 不破 MA10 （+ 多头排列 上下文）。
 *
 * 输出：中文摘要多行 + 末尾两行 ASCII（SUMMARY/VERDICT）供 PowerShell 解析。
 * 即使中文因编码显示异常，ASCII 两行也可读。
 * Usage: node confirm.js <secid>   secid: 深 0.xxxxxx  沪 1.xxxxxx
 */
const fs = require('fs');
const path = require('path');
const secid = process.argv[2];
if (!secid) { console.log('SUMMARY no-secid'); console.log('VERDICT: ERR'); process.exit(0); }

// ---------- 当日 intraday 快照缓存(JSONL, 按行追加, 避免并发写冲突) ----------
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'intraday');
function todayStr() { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.toISOString().slice(0, 10); }
function cacheFile() { return path.join(CACHE_DIR, `${todayStr()}.jsonl`); }
function readTodaySnapshots(forSecid) {
  try {
    const lines = fs.readFileSync(cacheFile(), 'utf8').split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(x => x && x.secid === forSecid);
  } catch { return []; }
}
function appendSnapshot(rec) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.appendFileSync(cacheFile(), JSON.stringify(rec) + '\n');
  } catch { /* 缓存写入失败不影响主流程 */ }
}
function cleanOldCache(keepDays = 14) {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    for (const f of files) {
      const fp = path.join(CACHE_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch { /* 忽略单个文件清理失败 */ }
    }
  } catch { /* 目录不存在等情况直接跳过 */ }
}
cleanOldCache();

const kUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=70`;
const fUrl = `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=1&klt=101`;
const dkUrl = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=6&klt=101`;

async function getJson(u) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(u).then(x => x.json()); if (r && r.data) return r; } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 500));
  }
  return null;
}

(async () => {
  const [k, f, dk] = await Promise.all([getJson(kUrl), getJson(fUrl), getJson(dkUrl)]);
  if (!k || !k.data || !k.data.klines || k.data.klines.length < 20) {
    console.log('SUMMARY kline-fail'); console.log('VERDICT: ERR'); return;
  }
  const rows = k.data.klines.map(s => s.split(','));
  const closes = rows.map(r => +r[2]);
  const vols = rows.map(r => +r[5]);
  const n = closes.length;
  const price = closes[n - 1];
  const ma = p => closes.slice(-p).reduce((a, b) => a + b, 0) / p;
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20), ma60 = n >= 60 ? ma(60) : NaN;
  const volMa5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volRatio = vols[n - 1] / volMa5;
  let rsi = null;
  if (n >= 15) { let g = 0, l = 0; for (let x = n - 14; x < n; x++) { const ch = closes[x] - closes[x - 1]; if (ch > 0) g += ch; else l += -ch; } const ag = g / 14, al = l / 14; rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  const name = k.data.name || secid;
  const bull = ma5 > ma10 && ma10 > ma20 && (isNaN(ma60) || ma20 > ma60);

  // 主力（当日 fflow 单日，含恒等式校验：主力=超大单+大单）
  let main = null, idOk = true, todayRatio = null, superL = null, largeL = null;
  if (f && f.data && f.data.klines && f.data.klines.length) {
    const p = f.data.klines[f.data.klines.length - 1].split(',');
    const m = +p[1] / 1e8, lg = +p[4] / 1e8, sup = +p[5] / 1e8;
    main = m; superL = sup; largeL = lg;
    idOk = Math.abs(m - (sup + lg)) < 0.01;
  }
  // 当天主力净占比 = 主力净额 / 成交额 (kline f57=成交额(元), 盘中两者同为部分,比值有效)
  const amtToday = rows[n - 1] && rows[n - 1][6] ? +rows[n - 1][6] : 0;
  if (main !== null && amtToday > 0) todayRatio = main * 1e8 / amtToday * 100;

  const OUT = -0.3;                                 // 明显净流出阈值(亿)，零附近视为噪声
  const cMain = main === null ? null : (main > 0 ? true : (main <= OUT ? false : null)); // 入/流出/中性
  const cVol = volRatio < 1.0;                      // 缩量(<均量, <0.7 更佳)
  const cMa10 = price >= ma10;                      // 不破 MA10
  const passN = [cMain === true, cVol, cMa10].filter(x => x === true).length;

  // 5日资金趋势(daykline). 关键: 不只看5日总和正负,还看"近日方向"——
  // 区分"5日净负 且 近日仍流出(还在流血)" vs "5日净负 但 近日主力回补中(在回来,该关注)"。
  let sum5 = null, worst = null, streak = 0, last2 = null;
  if (dk && dk.data && dk.data.klines && dk.data.klines.length) {
    const ks = dk.data.klines.slice(-5);
    const mains = ks.map(L => +L.split(',')[1] / 1e8);
    sum5 = mains.reduce((a, b) => a + b, 0);
    worst = Math.min(...ks.map(L => +L.split(',')[6]));
    for (let i = mains.length - 1; i >= 0; i--) { if (mains[i] > 0) streak++; else break; } // 最近连续净流入天数
    last2 = mains.slice(-2).reduce((a, b) => a + b, 0);
  }
  const recentInflow = (streak >= 2) || (last2 !== null && last2 > 0);                       // 近日主力在回补
  const recovering = sum5 !== null && sum5 < 0 && recentInflow;                              // 5日净负但在回来 -> 关注(如沪电6/30型)
  const stillBleeding = sum5 !== null && sum5 < 0 && !recentInflow && worst !== null && worst <= -8; // 暴量派发,近日仍流出 -> 避

  // 超跌反包 PASS: 非多头 但 站回MA20 + 当天主力净占比>=+10%(强反转) -> PASS 轻仓
  // (回测83笔: 站回MA20+净占比≥10% 期望+9.28% vs 主力流出-0.59%; 放量是主力买,故不受放量WAIT限制)
  const reboundBuy = !bull && price > ma20 && todayRatio !== null && todayRatio >= 10 && main > 0;

  // 买点距离检查(2026-07-16新增，照搬backtest/studies.js已回测验证的buyPoints()/strictBuy()定义，非新判断):
  // 顺势回踩买要求现价贴近MA10(±2%以内)，且止损距离(min(MA20,现价*0.97))不超过4%——
  // 光看"没破MA10"不够，价格已经反弹离MA10很远时不算真正的回踩点(紫光国微/恒瑞医药/药明康德/中兴通讯都撞过这个漏洞)。
  const nearMa10 = Math.abs(price - ma10) / ma10 <= 0.02;
  const stopRef = Math.min(ma20, price * 0.97);
  const stopDist = (price - stopRef) / price;
  const validStopDist = stopDist > 0 && stopDist <= 0.04;
  const atBuyPoint = nearMa10 && validStopDist;

  let verdict;
  if (main === null || !idOk) verdict = 'WAIT';           // 资金缺失/恒等式失败 -> 不据此下结论
  else if (!cMa10 || main <= OUT) verdict = 'FAIL';       // 破MA10 或 明显流出 -> 别接
  else if (rsi !== null && rsi > 70) verdict = 'WAIT';    // RSI超买 -> 风险收益差(回测+0.50 vs+2.63),两路径都拦
  else if (reboundBuy) verdict = 'PASS';                  // 超跌反包(站回MA20+净占比≥10%) -> 轻仓，买点定义不同，不受nearMa10限制
  else if (volRatio > 1.5) verdict = 'WAIT';              // 顺势路径: 放量需人工分辨突破/砸盘
  else if (main > 0 && bull) verdict = atBuyPoint ? 'PASS' : 'WAIT'; // 顺势回踩: 主力转正+守MA10+缩量+多头，且必须贴近MA10+止损距离达标才是真买点，否则是追高
  else verdict = 'WAIT';                                  // 主力未明确转正(近0)/非多头且非反包 -> 等
  // 注:「5日暴量派发未修复」回测仅弱支持(+2.35 vs +1.67, 拦掉52%且被拦者仍为正, 且窗口含暴跌被污染)
  //     -> 只作展示提醒, 不硬性改判 verdict, 交人工/Claude 结合MACD/RSI/位置权衡。

  const mk = b => b === true ? '[OK]' : b === false ? '[X]' : '[?]';
  const volTxt = volRatio < 0.7 ? '缩量' : volRatio < 1.0 ? '偏缩' : volRatio > 1.5 ? '放量' : '平量';
  console.log(`${name} 现价${price.toFixed(2)} 回踩买点确认:`);
  const mainTxt = main === null ? '数据缺失' : (main.toFixed(2) + '亿(净占比' + (todayRatio === null ? 'NA' : (todayRatio >= 0 ? '+' : '') + todayRatio.toFixed(1) + '%') + ') ' + (main > 0 ? '净流入' : main <= OUT ? '净流出' : '近0未转正'));
  console.log(`${mk(cMain)} 主力: ${mainTxt}${idOk ? '' : ' 恒等式失败!'}`);
  console.log(`${mk(cVol)} 量能: 今日/5日均量=${volRatio.toFixed(2)} ${volTxt} (盘中为部分量,参考)`);
  console.log(`${mk(cMa10)} 均线: 现价${price.toFixed(2)} / MA10 ${ma10.toFixed(2)} ${cMa10 ? '未破' : '已破!'} | ${bull ? '多头排列' : '非多头'}`);
  if (!reboundBuy) {
    const distPct = ((price - ma10) / ma10 * 100).toFixed(1);
    console.log(`${mk(atBuyPoint)} 买点: 离MA10${distPct >= 0 ? '+' : ''}${distPct}%(${nearMa10 ? '贴近' : '偏远,非回踩点'}) 止损距离${(stopDist * 100).toFixed(1)}%(${validStopDist ? '达标' : '过宽'})`);
  }
  const rsiOb = rsi !== null && rsi > 70;
  console.log(`${rsiOb ? '[X]' : '[OK]'} 强弱: RSI=${rsi === null ? 'NA' : rsi.toFixed(0)}${rsiOb ? ' 超买 -> 回踩买风险差,等冷却(回测已验证)' : ''}`);
  let f5mark, f5txt;
  if (sum5 === null) { f5mark = '[OK]'; f5txt = '5日数据缺'; }
  else if (recovering) { f5mark = '[~]'; f5txt = `5日主力${sum5.toFixed(1)}亿(净负) 但近${streak}日回补中(近2日${last2 >= 0 ? '+' : ''}${last2.toFixed(1)}) -> 主力在回来,关注`; }
  else if (stillBleeding) { f5mark = '[!]'; f5txt = `5日主力${sum5.toFixed(1)}亿 最差净占比${worst.toFixed(1)}% 暴量派发未修复(近日仍流出),避`; }
  else { f5mark = '[OK]'; f5txt = `5日主力${sum5 >= 0 ? '+' : ''}${sum5.toFixed(1)}亿`; }
  console.log(`${f5mark} 趋势: ${f5txt} (仅提醒,不改判)`);

  // 当日早晚对比: 读本地缓存里今天该股更早的快照, 跟本次比(超大单比主力合计更能看出是不是真在跑)
  const prior = readTodaySnapshots(secid);
  if (prior.length && main !== null) {
    const last = prior[prior.length - 1];
    const lastTime = last.time || '早前';
    if (last.main !== null && last.main !== undefined) {
      const trend = main > last.main + 0.3 ? '好转' : main < last.main - 0.3 ? '恶化' : '持平';
      let supTxt = '';
      if (last.superL !== null && last.superL !== undefined && superL !== null) {
        const supTrend = superL > last.superL + 0.3 ? '好转' : superL < last.superL - 0.3 ? '恶化' : '持平';
        supTxt = ` | 超大单${last.superL.toFixed(2)}→${superL.toFixed(2)}亿(${supTrend})`;
      }
      console.log(`[对比] 较上次(${lastTime}) 主力${last.main.toFixed(2)}→${main.toFixed(2)}亿(${trend})${supTxt}, 今日已有${prior.length}条快照`);
    }
  }
  // 写入本次快照供下次对比
  appendSnapshot({
    secid, name, time: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16),
    price, main, superL, largeL, todayRatio, volRatio, verdict,
  });

  const tip = verdict === 'PASS' ? (reboundBuy ? '超跌反包候选(站回MA20+主力净占比≥10%) -> 轻仓试,找我定手数/止损' : '顺势三项通过+已贴近MA10买点 -> 可考虑,找我定手数/止损/盈亏比')
    : verdict === 'FAIL' ? '主力流出或破MA10 -> 别接,放弃今天'
    : verdict === 'ERR' ? '数据拉取失败 -> 找我手动确认'
    : (!reboundBuy && main > 0 && bull && !atBuyPoint) ? `三项本身通过，但现价离MA10${nearMa10 ? '' : '偏远'}/止损距离${validStopDist ? '' : '过宽'}，不是真正回踩点，追高风险大 -> 等回踩MA10再看`
    : '未全过/放量 -> 谨慎,建议找我人工判断';
  console.log(`结论: ${tip}`);
  // ASCII 兜底两行（编码异常也可读，且供 PowerShell 解析）
  console.log(`SUMMARY main=${main === null ? 'NA' : main.toFixed(2)} vol=${volRatio.toFixed(2)} holdMA10=${cMa10 ? 'Y' : 'N'} bull=${bull ? 'Y' : 'N'} rsi=${rsi === null ? 'NA' : rsi.toFixed(0)} ratio=${todayRatio === null ? 'NA' : todayRatio.toFixed(1)} rebound=${reboundBuy ? 'Y' : 'N'} sum5=${sum5 === null ? 'NA' : sum5.toFixed(1)} worst=${worst === null ? 'NA' : worst.toFixed(1)} recover=${recovering ? 'Y' : 'N'} streak=${streak} nearMa10=${nearMa10 ? 'Y' : 'N'} stopDist=${(stopDist * 100).toFixed(1)}`);
  console.log(`VERDICT: ${verdict} (${passN}/3)`);
})();
