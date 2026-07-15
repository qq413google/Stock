#!/usr/bin/env node
// 数据接口探测：kline / flow 历史深度 + 翻页能力
const SECID = process.argv[2] || '1.600487'; // 亨通光电

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

// kline: push2his day kline
async function probeKline(secid, lmt, end) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=${end || '20500101'}&lmt=${lmt}`;
  try {
    const d = await fetchJson(url);
    const ks = d.data?.klines || [];
    return { ok: !!d.data, name: d.data?.name, count: ks.length, first: ks[0], last: ks[ks.length - 1] };
  } catch (e) { return { ok: false, err: String(e) }; }
}

// flow daykline
async function probeFlow(secid, lmt, end) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=${lmt}&klt=101${end ? `&end=${end}` : ''}`;
  try {
    const d = await fetchJson(url);
    const ks = d.data?.klines || [];
    return { ok: !!d.data, name: d.data?.name, count: ks.length, first: ks[0], last: ks[ks.length - 1] };
  } catch (e) { return { ok: false, err: String(e) }; }
}

(async () => {
  console.log('=== KLINE 探测 ===');
  console.log('lmt=600 (无end):', JSON.stringify(await probeKline(SECID, 600)));
  console.log('lmt=1200 (无end):', JSON.stringify(await probeKline(SECID, 1200)));
  // 翻页测试：取最早一段的末日，作为下一页 end
  const big = await probeKline(SECID, 600);
  if (big.last) {
    const endDate = big.last.split(',')[0].replace(/-/g, '');
    console.log(`翻页: end=${endDate}, lmt=600:`, JSON.stringify(await probeKline(SECID, 600, endDate)));
  }

  console.log('\n=== FLOW 探测 ===');
  console.log('lmt=20:', JSON.stringify(await probeFlow(SECID, 20)));
  console.log('lmt=60:', JSON.stringify(await probeFlow(SECID, 60)));
  console.log('lmt=250:', JSON.stringify(await probeFlow(SECID, 250)));
  const fbig = await probeFlow(SECID, 250);
  if (fbig.last) {
    const endDate = fbig.last.split(',')[0].replace(/-/g, '');
    console.log(`翻页: end=${endDate}, lmt=250:`, JSON.stringify(await probeFlow(SECID, 250, endDate)));
  }
})();
