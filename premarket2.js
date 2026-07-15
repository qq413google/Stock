const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers: {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.eastmoney.com/'}}, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}

(async () => {
  // 个股实时 - 换secid格式试试
  console.log('========== 关注个股实时（单只查询） ==========');
  const stocks = [
    {code:'002463', name:'沪电股份', market:2},
    {code:'002050', name:'三花智控', market:1},
    {code:'600288', name:'亨通光电', market:1},
  ];
  
  for (const s of stocks) {
    try {
      const secid = s.market + '.' + s.code;
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f116,f117,f162,f167,f170,f171,f292`;
      const data = await fetch(url);
      const json = JSON.parse(data);
      if (json.data) {
        const d = json.data;
        console.log(`\n--- ${s.name} (${s.code}) ---`);
        console.log(`现价: ${d.f43/100}, 涨跌幅: ${d.f170 !== null ? (d.f170/100).toFixed(2) : '?'}%, 开盘: ${d.f44 !== null ? d.f44/100 : '?'}, 最高: ${d.f45 !== null ? d.f45/100 : '?'}, 最低: ${d.f46 !== null ? d.f46/100 : '?'}`);
        console.log(`成交额: ${(d.f48/100000000).toFixed(2)}亿, 成交量: ${d.f47}手, 换手率: ${d.f168 !== null ? (d.f168/100).toFixed(2) : '?'}%`);
        console.log(`PE: ${d.f162 !== null ? (d.f162/100).toFixed(2) : '?'}, PB: ${d.f167 !== null ? (d.f167/100).toFixed(2) : '?'}, 总市值: ${(d.f116/100000000).toFixed(0)}亿, 流通市值: ${(d.f117/100000000).toFixed(0)}亿`);
        console.log(`昨收: ${d.f60/100}, 52周高: ${d.f51 !== null ? f51/100 : '?'}, 52周低: ${d.f52 !== null ? d.f52/100 : '?'}`);
      } else {
        console.log(`${s.name}: 无数据, raw:`, data.substring(0, 300));
      }
    } catch(e) { console.log(s.name + ' error:', e.message); }
  }

  // 个股近60日K线
  console.log('\n========== 个股近60日K线（取最近5日展示） ==========');
  for (const s of stocks) {
    try {
      const secid = s.market + '.' + s.code;
      const kurl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59&klt=101&fqt=1&end=20260708&lmt=60`;
      const kdata = await fetch(kurl);
      const kjson = JSON.parse(kdata);
      if (kjson.data && kjson.data.klines) {
        const klines = kjson.data.klines;
        console.log(`\n--- ${s.name} 近5日K线 ---`);
        const last5 = klines.slice(-5);
        last5.forEach(k => {
          const parts = k.split(',');
          console.log(`${parts[0]}: 开${parts[1]} 收${parts[2]} 高${parts[3]} 低${parts[4]} 量${parts[5]}额${parts[6]} 涨跌${parts[8]}%`);
        });
        
        // 计算均线
        if (klines.length >= 60) {
          const closes = klines.map(k => parseFloat(k.split(',')[2]));
          const ma5 = closes.slice(-5).reduce((a,b) => a+b, 0) / 5;
          const ma10 = closes.slice(-10).reduce((a,b) => a+b, 0) / 10;
          const ma20 = closes.slice(-20).reduce((a,b) => a+b, 0) / 20;
          const ma60 = closes.slice(-60).reduce((a,b) => a+b, 0) / 60;
          const lastClose = closes[closes.length - 1];
          console.log(`MA5=${ma5.toFixed(2)} MA10=${ma10.toFixed(2)} MA20=${ma20.toFixed(2)} MA60=${ma60.toFixed(2)} 现价=${lastClose}`);
          
          // 均线排列判断
          if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) {
            console.log('均线排列: 多头排列 ✅');
          } else if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) {
            console.log('均线排列: 空头排列 🔴');
          } else {
            console.log(`均线排列: 混合 ⚠️ (MA5${ma5>ma10?'>':'<'}MA10 MA10${ma10>ma20?'>':'<'}MA20 MA20${ma20>ma60?'>':'<'}MA60)`);
          }
          
          // RSI(14)
          if (closes.length >= 15) {
            let gains = 0, losses = 0;
            for (let i = closes.length - 14; i < closes.length; i++) {
              const change = closes[i] - closes[i-1];
              if (change > 0) gains += change;
              else losses -= change;
            }
            const avgGain = gains / 14;
            const avgLoss = losses / 14;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            const rsi = 100 - (100 / (1 + rs));
            console.log(`RSI(14)=${rsi.toFixed(1)} ${rsi > 70 ? '🔴超买' : rsi < 30 ? '🟢超卖' : '✅正常'}`);
          }
          
          // MACD (12,26,9)
          if (closes.length >= 35) {
            const ema = (arr, period) => {
              const k = 2 / (period + 1);
              let ema = arr[0];
              for (let i = 1; i < arr.length; i++) {
                ema = arr[i] * k + ema * (1 - k);
              }
              return ema;
            };
            const ema12 = ema(closes.slice(-35), 12);
            const ema26 = ema(closes.slice(-35), 26);
            const dif = ema12 - ema26;
            // 计算DEA需要历史DIF
            const difs = [];
            for (let i = 26; i <= closes.length; i++) {
              const slice = closes.slice(0, i);
              const e12 = ema(slice.slice(-35), 12);
              const e26 = ema(slice.slice(-35), 26);
              difs.push(e12 - e26);
            }
            const dea = ema(difs.slice(-9), 9);
            const macd = (dif - dea) * 2;
            console.log(`MACD: DIF=${dif.toFixed(3)} DEA=${dea.toFixed(3)} MACD柱=${macd.toFixed(3)} ${dif > dea ? '✅金叉' : '🔴死叉'} ${dif > dea && macd > 0 ? '红柱' : '绿柱'}`);
          }
          
          // 布林带
          if (closes.length >= 20) {
            const last20 = closes.slice(-20);
            const mean = last20.reduce((a,b) => a+b, 0) / 20;
            const variance = last20.reduce((a,b) => a + (b - mean) ** 2, 0) / 20;
            const std = Math.sqrt(variance);
            const upper = mean + 2 * std;
            const lower = mean - 2 * std;
            const pos = (lastClose - lower) / (upper - lower) * 100;
            console.log(`布林带: 上轨=${upper.toFixed(2)} 中轨=${mean.toFixed(2)} 下轨=${lower.toFixed(2)} 位置=${pos.toFixed(0)}% ${pos > 80 ? '🔴接近上轨' : pos < 20 ? '🟢接近下轨' : '✅中段'}`);
          }
          
          // 成交量分析
          const vols = klines.map(k => parseFloat(k.split(',')[5]));
          const vol5 = vols.slice(-5).reduce((a,b) => a+b, 0) / 5;
          const vol20 = vols.slice(-20).reduce((a,b) => a+b, 0) / 20;
          const lastVol = vols[vols.length - 1];
          console.log(`最近量: ${lastVol.toFixed(0)} 5日均量: ${vol5.toFixed(0)} 20日均量: ${vol20.toFixed(0)} ${lastVol < vol5 * 0.7 ? '🟢缩量' : lastVol > vol5 * 1.5 ? '🔴放量' : '✅正常'}`);
        }
      }
    } catch(e) { console.log(s.name + ' K线error:', e.message); }
  }

  // 美股重要个股表现
  console.log('\n========== 美股重要科技股隔夜表现 ==========');
  const usStocks = [
    {code:'105.NVDA', name:'英伟达'},
    {code:'105.AAPL', name:'苹果'},
    {code:'105.AMD', name:'AMD'},
    {code:'105.AVGO', name:'博通'},
    {code:'105.MU', name:'美光'},
    {code:'105.TSM', name:'台积电'},
  ];
  for (const s of usStocks) {
    try {
      const kurl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${s.code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20260708&lmt=2`;
      const kdata = await fetch(kurl);
      const kjson = JSON.parse(kdata);
      if (kjson.data && kjson.data.klines) {
        const lastK = kjson.data.klines[kjson.data.klines.length - 1];
        const [date, open, close, high, low, vol, amount, pct] = lastK.split(',');
        console.log(`${s.name}(${date}): 收${close} 涨跌${pct}%`);
      }
    } catch(e) { console.log(s.name + ' error:', e.message); }
  }

  // 北向资金
  console.log('\n========== 北向资金 ==========');
  try {
    const nUrl = 'https://push2.eastmoney.com/api/qt/kamt.rtmin/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56';
    const nData = await fetch(nUrl);
    const nJson = JSON.parse(nData);
    if (nJson.data && nJson.data.s2n) {
      const lines = nJson.data.s2n;
      console.log('北向数据条数:', lines.length);
      if (lines.length > 0) {
        const last = lines[lines.length - 1].split(',');
        console.log('最新:', last.join(' | '));
      }
    } else {
      console.log('北向raw:', nData.substring(0, 500));
    }
  } catch(e) { console.log('北向error:', e.message); }

  // 人民币汇率
  console.log('\n========== 人民币汇率 ==========');
  try {
    const fxUrl = 'https://push2.eastmoney.com/api/qt/stock/get?secid=119.USDCNY&fields=f43,f44,f45,f46,f57,f58,f60,f170';
    const fxData = await fetch(fxUrl);
    const fxJson = JSON.parse(fxData);
    if (fxJson.data) {
      const d = fxJson.data;
      console.log(`美元/人民币: ${d.f43/100} 涨跌: ${d.f170 !== null ? (d.f170/100).toFixed(2) : '?'}%`);
    }
  } catch(e) { console.log('汇率error:', e.message); }

})();
