#!/usr/bin/env node
/**
 * 分时走势查询脚本
 * Usage: node trends.js <secid> [lastN]
 * Example: node trends.js 0.300433 20
 * 
 * 输出: 时间,开盘,收盘,最高,最低,成交量,成交额,均价
 */
const secid = process.argv[2];
const lastN = process.argv[3] || '20';
if (!secid) {
  console.error('Usage: node trends.js <secid> [lastN]');
  process.exit(1);
}
const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1`;
fetch(url).then(r => r.json()).then(d => {
  if (!d.data || !d.data.trends) {
    console.error('No data'); process.exit(1);
  }
  const k = d.data.trends;
  const n = parseInt(lastN);
  const slice = k.slice(-n);
  console.log(`${d.data.name} 分时走势(最近${n}条):`);
  slice.forEach(x => console.log(x));
});
