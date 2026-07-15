#!/usr/bin/env node
/**
 * 板块涨幅排名查询脚本
 * Usage: node sector.js [limit]
 * Example: node sector.js 10
 */
const limit = process.argv[2] || '10';
// 注意: f6=成交额(元), f20=总市值(元)。早期版本误用 f20 当成交额，已修正为 f6。
const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3&fields=f2,f3,f6,f12,f14,f20`;
fetch(url).then(r => r.json()).then(d => {
  if (!d.data || !d.data.diff) {
    console.error('No data'); process.exit(1);
  }
  console.log(`板块涨幅TOP${limit}:`);
  d.data.diff.forEach((x, i) => {
    const amt = x.f6 ? (x.f6 / 1e8).toFixed(1) : '-';
    console.log(`${i+1}. ${x.f14}(${x.f12}): ${x.f3}% 成交额:${amt}亿`);
  });
});
