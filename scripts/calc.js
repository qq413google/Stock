#!/usr/bin/env node
/**
 * 技术指标计算脚本（实时拉K线，自动计算）
 * Usage: node calc.js <secid> [lmt]
 * Example: node calc.js 1.600487
 *          node calc.js 0.300433 120
 *
 * secid: 深市 0.XXXXXX  沪市 1.XXXXXX
 * 输出: MA5/10/20/60、RSI14、MACD(12,26,9 含DIF/DEA)、KDJ(9,3,3)、均线排列、量价
 *
 * 注：旧版为硬编码 6/26 样例数据且 MACD 误把"DIF>0"当金叉（金叉应是 DIF 上穿 DEA），已重写。
 */
const secid = process.argv[2];
const lmt = process.argv[3] || '120';
if (!secid) {
  console.error('Usage: node calc.js <secid> [lmt]');
  console.error('Example: node calc.js 1.600487');
  process.exit(1);
}

// EMA 序列（标准：种子=首值，逐日递推）
function emaSeries(data, period) {
  const k = 2 / (period + 1);
  const out = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${lmt}`;
fetch(url).then(r => r.json()).then(d => {
  if (!d.data || !d.data.klines || d.data.klines.length < 20) {
    console.error('No data or insufficient klines'); process.exit(1);
  }
  const rows = d.data.klines.map(s => s.split(','));
  const closes = rows.map(r => +r[2]);
  const highs = rows.map(r => +r[3]);
  const lows = rows.map(r => +r[4]);
  const vols = rows.map(r => +r[5]);
  const n = closes.length;
  const last = closes[n - 1];

  // 均线
  const ma = p => closes.slice(-p).reduce((a, b) => a + b, 0) / p;
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20), ma60 = n >= 60 ? ma(60) : NaN;

  // RSI14（简单均值法，取最近14日）
  const gains = [], losses = [];
  for (let i = 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(ch > 0 ? ch : 0);
    losses.push(ch < 0 ? -ch : 0);
  }
  const avgGain = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const avgLoss = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // MACD(12,26,9): DIF = EMA12-EMA26, DEA = EMA9(DIF), MACD柱 = 2*(DIF-DEA)
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const difSeries = closes.map((_, i) => ema12[i] - ema26[i]);
  const deaSeries = emaSeries(difSeries, 9);
  const dif = difSeries[n - 1], dea = deaSeries[n - 1];
  const macd = 2 * (dif - dea);
  const difPrev = difSeries[n - 2], deaPrev = deaSeries[n - 2];
  let macdSignal = dif > dea ? 'DIF在DEA上方(多头)' : 'DIF在DEA下方(空头)';
  if (difPrev <= deaPrev && dif > dea) macdSignal = '金叉 ✅(DIF上穿DEA)';
  else if (difPrev >= deaPrev && dif < dea) macdSignal = '死叉 🔴(DIF下穿DEA)';

  // KDJ(9,3,3): RSV→K(2/3前+1/3RSV)→D(2/3前+1/3K)→J=3K-2D，递推，种子K=D=50
  let K = 50, D = 50;
  for (let i = 0; i < n; i++) {
    const h9 = Math.max(...highs.slice(Math.max(0, i - 8), i + 1));
    const l9 = Math.min(...lows.slice(Math.max(0, i - 8), i + 1));
    const rsv = h9 === l9 ? 50 : (closes[i] - l9) / (h9 - l9) * 100;
    K = (2 / 3) * K + (1 / 3) * rsv;
    D = (2 / 3) * D + (1 / 3) * K;
  }
  const J = 3 * K - 2 * D;

  // 量价
  const volMa5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volRatio = vols[n - 1] / volMa5;

  console.log(`=== ${d.data.name}(${d.data.code}) 收盘 ${last} ===`);
  console.log(`MA5:${ma5.toFixed(2)} MA10:${ma10.toFixed(2)} MA20:${ma20.toFixed(2)} MA60:${isNaN(ma60) ? '-' : ma60.toFixed(2)}`);
  const arr = ma5 > ma10 && ma10 > ma20 && (isNaN(ma60) || ma20 > ma60) ? '多头排列 ✅'
    : ma5 < ma10 && ma10 < ma20 ? '空头排列 🔴' : '均线交织 🟡';
  console.log(`均线排列: ${arr}`);
  console.log(`RSI(14): ${rsi.toFixed(2)} ${rsi > 70 ? '超买 ⚠️' : rsi < 30 ? '超卖 🟢' : '正常'}`);
  console.log(`MACD: DIF=${dif.toFixed(3)} DEA=${dea.toFixed(3)} 柱=${macd.toFixed(3)} → ${macdSignal}`);
  console.log(`KDJ: K=${K.toFixed(2)} D=${D.toFixed(2)} J=${J.toFixed(2)} ${K > 80 ? '超买 ⚠️' : K < 20 ? '超卖 🟢' : ''}`);
  console.log(`量价: 今日量/5日均量=${volRatio.toFixed(2)} ${volRatio > 1.5 ? '放量' : volRatio < 0.7 ? '缩量' : '平量'}`);
});
