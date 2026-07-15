#!/usr/bin/env node
/**
 * 持仓与账户级风控校验
 * Usage: node positions.js
 * 读取 ../positions.json，拉实时价，算浮盈亏，校验 -8%硬顶/止损价/集中度。
 */
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'positions.json'), 'utf8'));
const acc = cfg.account || {};
const pos = cfg.持仓 || [];
const cap = acc.总资金 || 50000;

(async () => {
  console.log(`=== 账户 (总资金 ${cap} / 可用现金 ${acc.可用现金 != null ? acc.可用现金 : '?'}) 更新:${acc.更新日期 || '-'} ===`);
  if (!pos.length) { console.log('当前空仓 ✅'); return; }

  let mktVal = 0; const lanes = {};
  for (const p of pos) {
    const d = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${p.代码}&fields=f43,f58,f60`).then(r => r.json());
    const cur = d.data.f43 / 100;
    const val = cur * p.股数; mktVal += val;
    lanes[p.赛道] = (lanes[p.赛道] || 0) + val;
    const pl = (cur - p.成本价) / p.成本价 * 100;
    const plAmt = (cur - p.成本价) * p.股数;
    const warn = [];
    if (pl <= -8) warn.push('🔴超-8%硬顶,立即清');
    else if (p.止损价 && cur <= p.止损价) warn.push('🔴破止损价');
    else if (pl <= -5) warn.push('⚠️接近止损');
    console.log(`${d.data.f58}(${p.代码}) 成本${p.成本价} 现价${cur.toFixed(2)} 浮${pl >= 0 ? '盈' : '亏'}${pl.toFixed(2)}%(${plAmt.toFixed(0)}元) 止损${p.止损价 || '-'} ${warn.join(' ')}`);
  }
  const posPct = mktVal / cap * 100;
  console.log(`--- 持仓 ${pos.length} 只 市值 ${mktVal.toFixed(0)} 仓位 ${posPct.toFixed(1)}% ---`);
  if (pos.length > 3) console.log('🔴 持仓 >3 只，超集中度上限');
  for (const [k, v] of Object.entries(lanes)) {
    const lp = v / cap * 100;
    if (lp > 50) console.log(`🔴 赛道[${k}] ${lp.toFixed(1)}% > 50% 上限`);
  }
})();
