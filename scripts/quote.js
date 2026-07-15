#!/usr/bin/env node
/**
 * 股票实时行情查询脚本
 * Usage: node quote.js <secid>
 * Example: node quote.js 0.300433  (深市)
 *          node quote.js 1.600584  (沪市)
 * 
 * secid格式: 市场代码.股票代码
 *   深市: 0.XXXXXX  沪市: 1.XXXXXX
 * 
 * 输出字段:
 *   f43=现价 f44=最高 f45=最低 f46=今开 f47=成交量 f48=成交额
 *   f57=代码 f58=名称 f60=昨收 f168=外盘 f169=内盘 f170=涨跌幅(×100,需/100; 本脚本不依赖f170,直接用(f43-f60)/f60自算)
 */
const secid = process.argv[2];
if (!secid) {
  console.error('Usage: node quote.js <secid>');
  console.error('Example: node quote.js 0.300433');
  process.exit(1);
}
const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f170,f168,f169`;
fetch(url).then(r => r.json()).then(d => {
  if (!d.data) { console.error('No data'); process.exit(1); }
  const v = d.data;
  const price = v.f43 / 100;
  const preClose = v.f60 / 100;
  const change = ((price - preClose) / preClose * 100).toFixed(2);
  console.log(`${v.f58}(${v.f57}): 现价=${price} 涨跌幅=${change}% 最高=${v.f44/100} 最低=${v.f45/100} 今开=${v.f46/100} 昨收=${preClose} 成交量=${v.f47}手 成交额=${(v.f48/1e8).toFixed(2)}亿 外盘=${v.f168} 内盘=${v.f169}`);
});
