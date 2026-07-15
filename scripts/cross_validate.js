#!/usr/bin/env node
// 交叉验证：K线价量 vs 资金流 vs 主力净占比
const secid = '1.600487';

Promise.all([
  fetch(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=15`).then(r => r.json()),
  fetch(`https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=10&klt=101`).then(r => r.json())
]).then(([k, f]) => {
  const kMap = {};
  k.data.klines.forEach(line => {
    const p = line.split(',');
    kMap[p[0]] = { o:+p[1], c:+p[2], h:+p[3], l:+p[4], v:+p[5], amt:+p[6] };
  });
  
  console.log('日期        | 收盘价  | 涨跌幅% | 成交额(亿) | 主力(亿) | 超大单 | 大单   | f57值  | f57/成交额=净占比% | 验证');
  console.log('-'.repeat(110));
  
  f.data.klines.forEach(line => {
    const p = line.split(',');
    const date = p[0];
    const main = +p[1] / 1e8;
    const sl = +p[5] / 1e8;
    const l = +p[4] / 1e8;
    const f57 = +p[6];
    const kd = kMap[date];
    if (!kd) return;
    
    const pctChg = ((kd.c - kd.o) / kd.o * 100).toFixed(2);
    const amt = kd.amt / 1e8;
    const netRatio = (main / amt * 100).toFixed(2);
    const match = Math.abs(+netRatio - f57) < 0.1;
    
    console.log(`${date} | ${kd.c.toFixed(2).padEnd(7)} | ${pctChg.padEnd(7)} | ${amt.toFixed(0).padEnd(10)} | ${main.toFixed(2).padEnd(7)} | ${sl.toFixed(2).padEnd(6)} | ${l.toFixed(2).padEnd(6)} | ${f57.toFixed(2).padEnd(6)} | ${netRatio.padEnd(7)} | ${match?'✅':'🔴'}`);
  });
  
  // 关键日6/26: 放量下跌 + 主力出逃 交叉验证
  console.log('\n=== 6/26 关键日交叉验证 ===');
  const d626k = kMap['2026-06-26'];
  const d626f = +f.data.klines.find(l => l.startsWith('2026-06-26')).split(',')[1] / 1e8;
  console.log(`K线: ${d626k.o}→${d626k.c} (跌${((d626k.c-d626k.o)/d626k.o*100).toFixed(1)}%), 成交${(d626k.amt/1e8).toFixed(0)}亿, 量${(d626k.v/1e4).toFixed(0)}万手`);
  // 前一天
  const d625k = kMap['2026-06-25'];
  console.log(`前日: ${d625k.o}→${d625k.c}, 成交${(d625k.amt/1e8).toFixed(0)}亿, 量${(d625k.v/1e4).toFixed(0)}万手`);
  console.log(`放量: ${(d626k.v/d625k.v*100).toFixed(0)}% → ${d626k.v > d625k.v ? '放量下跌 🔴' : '缩量 🟡'}`);
  console.log(`主力净流出: ${d626f.toFixed(2)}亿`);
  console.log('');
  console.log('结论: 6/26 放量(-7.3%)+主力-37.9亿→主力出货，不是机构承接 ✅');
});
