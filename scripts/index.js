#!/usr/bin/env node
/**
 * 指数行情查询脚本
 * Usage: node index.js
 * 输出: 上证指数、深证成指、创业板指
 */
const indices = [
  { secid: '1.000001', name: '上证指数' },
  { secid: '0.399001', name: '深证成指' },
  { secid: '0.399006', name: '创业板指' }
];

Promise.all(indices.map(idx => {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${idx.secid}&fields=f43,f44,f45,f46,f170,f48`;
  return fetch(url).then(r => r.json()).then(d => ({ ...idx, data: d.data }));
})).then(results => {
  results.forEach(r => {
    if (!r.data) return;
    const price = (r.data.f43 / 100).toFixed(2);
    const change = (r.data.f170 / 100).toFixed(2);
    const vol = (r.data.f48 / 1e8).toFixed(0);
    console.log(`${r.name}: ${price} ${change > 0 ? '+' : ''}${change}% 成交额:${vol}亿`);
  });
});
