#!/usr/bin/env node
/**
 * 日K线查询脚本
 * Usage: node kline.js <secid> [limit]
 * Example: node kline.js 0.300433 10
 * 
 * 输出: 日期,开盘,收盘,最高,最低,成交量(手),成交额
 */
const secid = process.argv[2];
const limit = process.argv[3] || '10';
if (!secid) {
  console.error('Usage: node kline.js <secid> [limit]');
  process.exit(1);
}
const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${limit}`;
fetch(url).then(r => r.json()).then(d => {
  if (!d.data || !d.data.klines) {
    console.error('No data'); process.exit(1);
  }
  console.log(`${d.data.name} 近${limit}日K线:`);
  console.log('日期,开盘,收盘,最高,最低,成交量(手),成交额');
  d.data.klines.forEach(k => console.log(k));
});
