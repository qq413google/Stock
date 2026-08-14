#!/usr/bin/env node
/**
 * 自动布防：读 watchlist.json，给"站上 MA60 + 价≤180 + 上方有支撑可回踩"的票
 * 自动生成「回踩支撑」触发器，写入 alerts.json（供 tasks/check-alerts.ps1 盯盘）。
 *
 * 入选条件（顺势回踩候选，过滤破位/超价/弱势）：
 *   1. 收盘 > MA60      （长期上升趋势）
 *   2. 收盘 > MA20      （趋势未破，非破位）
 *   3. 支撑位 ≤ 180     （回踩买入价在价格上限内，单手≤1.8万）
 * 支撑位取法：价>MA10 → 盯 MA10；MA20<价≤MA10 → 盯 MA20（更深支撑）。
 * 触发器：op '>' 支撑位 —— 价格"反弹收复"支撑(从下方重新站上)时盯盘弹窗提醒（缩量企稳+主力流入再由我过闸门）。
 *   对应 v2.0「回踩买点=缩量企稳不破,企稳反弹时买 / 超跌反包=站回关键均线」:只在实际 rebound 后才提醒,避免下落中接飞刀。
 *
 * 手动触发器：alerts.json 里标 "manual": true 的条目会被保留，不被覆盖。
 * Usage: node scripts/arm-alerts.js          (默认写入)
 *        node scripts/arm-alerts.js --dry     (只打印，不写文件)
 *
 * ⚠️ 触发只代表"价位到了"，不等于该买。买不买仍须跑 v2.0 全闸门。
 */
const fs = require('fs');
const path = require('path');
const DRY = process.argv.includes('--dry');
const PRICE_CAP = 180;

const root = path.join(__dirname, '..');
const wl = JSON.parse(fs.readFileSync(path.join(root, 'watchlist.json'), 'utf8')).stocks;
const alertsFile = path.join(root, 'alerts.json');

async function getKline(s) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${s.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=70`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const k = await fetch(u).then(r => r.json());
      const kl = ((k.data && k.data.klines) || []).map(L => { const p = L.split(','); return { c: +p[2], h: +p[3], l: +p[4] }; });
      if (kl.length >= 61) return { ...s, kl };
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return { ...s, kl: [] };
}
const ma = (kl, i, n) => kl.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n;

(async () => {
  // 保留手动钉的触发器 + arm-positions 生成的持仓止损/加仓线(posauto)。
  // 2026-08-07教训: 此前只留 manual, 单独手跑本脚本会把持仓止损触发器整批冲掉
  // (蓝思建仓当天真实发生过,持仓裸奔~2分钟)。posauto 条目由 arm-positions 自行去重刷新,
  // 这里保留不会重复,只会防止"手动刷新买入布防"顺手拆掉卖出保护。
  let manual = [];
  try {
    const prev = JSON.parse(fs.readFileSync(alertsFile, 'utf8'));
    manual = (prev.alerts || []).filter(a => a.manual === true || a.posauto === true);
  } catch (e) { /* 文件不存在/损坏，忽略 */ }
  const manualCodes = new Set(manual.map(a => a.tencent));

  // 持仓票交给 arm-positions.js 布"止损/移动止损/加仓"，这里不再给它们生成"低吸买入"单
  // （持有的票不该再挂买入观察）。持仓 代码 是 secid(0.xxx/1.xxx)，转成 tencent 比对。
  let heldCodes = new Set();
  try {
    const pc = JSON.parse(fs.readFileSync(path.join(root, 'positions.json'), 'utf8'));
    heldCodes = new Set((pc.持仓 || []).map(h => { const [mk, c] = String(h.代码).split('.'); return (mk === '0' ? 'sz' : 'sh') + c; }));
  } catch (e) { /* 无持仓文件忽略 */ }

  const data = [];
  for (const s of wl) { data.push(await getKline(s)); await new Promise(r => setTimeout(r, 150)); }

  // 刷新 track 型手动条目的价格(跟随均线, *1.01 作"收复提醒线", op '>' 反弹站上才弹)
  const byTen = {};
  for (const s of data) if (s.tencent) byTen[s.tencent] = s;
  const trackedLog = [];
  for (const m of manual) {
    if (!m.track) continue;
    const s = byTen[m.tencent];
    if (!s || !s.kl || s.kl.length < 20) continue;
    const i = s.kl.length - 1;
    const n = m.track === 'MA5' ? 5 : m.track === 'MA20' ? 20 : m.track === 'MA60' ? 60 : 10;
    if (n === 60 && s.kl.length < 61) continue;
    m.price = +(ma(s.kl, i, n) * 1.01).toFixed(2);
    trackedLog.push(`${m.name} ${m.track}*1.01=${m.price}`);
  }

  const auto = [];
  const skipped = [];
  for (const s of data) {
    if (manualCodes.has(s.tencent)) { skipped.push(`${s.name}(手动钉,跳过自动)`); continue; }
    if (heldCodes.has(s.tencent)) { skipped.push(`${s.name}(持仓中,交由arm-positions布止损)`); continue; }
    const kl = s.kl;
    if (kl.length < 61) { skipped.push(`${s.name}(数据不足)`); continue; }
    const i = kl.length - 1;
    const c = kl[i].c, m10 = ma(kl, i, 10), m20 = ma(kl, i, 20), m60 = ma(kl, i, 60);
    // 2026-07-22教训: kl[i].c 在盘中重跑时是"今天实时价"(东财日K线接口开盘后当天这根会实时更新),
    // 不是"昨收"——5%禁买线的基准必须用真正收盘完的前一天(kl[i-1]),不能用 kl[i].c，
    // 否则9:30自动布防还大致准，但盘中手动重跑时(价已经涨上去了)基准会被污染，等于没检查。
    const prevC = kl[i - 1].c;
    // 超跌反包候选: 收盘<=MA20(超跌) -> 布"站回MA20"触发,confirm按主力净占比判(回测:站回MA20+净占比≥10% 期望+9.28%)
    if (c <= m20) {
      if (m20 > PRICE_CAP) { skipped.push(`${s.name}(MA20 ${m20.toFixed(0)}>180超价)`); continue; }
      // 中兴通讯教训: 暴跌后MA20是滞后指标,跌得越狠MA20离现价越远;
      // 若MA20本身已经隐含相对昨收>3%涨幅,这条触发线一旦真的碰到就必然撞上
      // "当日涨>3%"硬性禁买线(v2.14,原5%),永远不可能产生合法买点,不该布防(等昨收回升到差距<3%再说)。
      if (m20 > prevC * 1.03) { skipped.push(`${s.name}(MA20 ${m20.toFixed(2)} 较昨收${prevC.toFixed(2)}已超3%,站回即撞禁买线,不布)`); continue; }
      auto.push({
        name: s.name, tencent: s.tencent, op: '>', price: +m20.toFixed(2),
        msg: `站回MA20(${m20.toFixed(2)}) 超跌反包候选:主力净占比≥+10%+缩量 再轻仓(confirm自动判)`,
        enabled: true, confirm: true, rebound: true
      });
      continue;
    }
    if (!(c > m60)) { skipped.push(`${s.name}(破MA60/弱势,已站MA20)`); continue; }
    const support = c > m10 ? m10 : m20;
    const supName = c > m10 ? 'MA10' : 'MA20';
    if (support > PRICE_CAP) { skipped.push(`${s.name}(支撑${support.toFixed(0)}>180超价)`); continue; }
    if (support > prevC * 1.03) { skipped.push(`${s.name}(支撑${support.toFixed(2)}较昨收${prevC.toFixed(2)}已超3%,收复即撞禁买线,不布)`); continue; }
    const price = +support.toFixed(2);
    const trig = {
      name: s.name, tencent: s.tencent, op: '>', price,
      msg: `反弹收复${supName}(${price}) 低吸观察:缩量企稳+主力净流入再确认(非追高)`,
      enabled: true
    };
    if (s.confirm === true) trig.confirm = true; // watchlist 里手动标 confirm:true 的票带自动确认(现无预设;想重点盯某只再单独加)
    auto.push(trig);
  }

  const out = {
    _comment: '自动布防生成(scripts/arm-alerts.js)。每日开盘前重跑刷新。标 manual:true 的条目会被保留。触发=价位到了,买不买仍须过 v2.0 全闸门。',
    _generated: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' (北京)',
    alerts: [...manual, ...auto]
  };

  console.log(`=== 自动布防 ${out._generated} ===`);
  console.log(`手动保留 ${manual.length} 条 | 自动生成 ${auto.length} 条`);
  if (trackedLog.length) console.log(`track刷新: ${trackedLog.join(', ')}`);
  auto.forEach(a => console.log(`  ★ ${a.name} ${a.op}${a.price}${a.confirm ? ' [confirm]' : ''} (${a.msg.split(' ')[0]})`));
  if (skipped.length) console.log(`跳过: ${skipped.join(', ')}`);

  if (DRY) { console.log('\n[--dry] 未写文件。'); return; }
  fs.writeFileSync(alertsFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n✅ 已写入 ${alertsFile}（共 ${out.alerts.length} 条触发器）`);
})();
