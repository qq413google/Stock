const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers: {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.eastmoney.com/'}}, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getStockRealtime(secid, name) {
  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168,f170`;
    const data = await fetch(url);
    const json = JSON.parse(data);
    if (json.data) {
      const d = json.data;
      console.log(`\n--- ${name} ---`);
      console.log(`现价: ${d.f43 !== null ? (d.f43/100).toFixed(2) : 'N/A'}, 涨跌幅: ${d.f170 !== null ? (d.f170/100).toFixed(2) + '%' : 'N/A'}`);
      console.log(`昨收: ${d.f60 !== null ? (d.f60/100).toFixed(2) : 'N/A'}, 开盘: ${d.f44 !== null ? (d.f44/100).toFixed(2) : 'N/A'}`);
      console.log(`PE: ${d.f162 !== null ? (d.f162/100).toFixed(2) : 'N/A'}, PB: ${d.f167 !== null ? (d.f167/100).toFixed(2) : 'N/A'}`);
      console.log(`总市值: ${d.f116 !== null ? (d.f116/100000000).toFixed(0) + '亿' : 'N/A'}, 流通市值: ${d.f117 !== null ? (d.f117/100000000).toFixed(0) + '亿' : 'N/A'}`);
    } else {
      console.log(`${name}: 无实时数据（可能竞价未开始）`);
    }
  } catch(e) { console.log(name + ' realtime error:', e.message); }
}

async function getKlines(secid, name, limit=60) {
  try {
    const kurl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59&klt=101&fqt=1&end=20260708&lmt=${limit}`;
    const kdata = await fetch(kurl);
    const kjson = JSON.parse(kdata);
    if (kjson.data && kjson.data.klines) {
      const klines = kjson.data.klines;
      console.log(`\n--- ${name} 近5日K线 ---`);
      const last5 = klines.slice(-5);
      last5.forEach(k => {
        const parts = k.split(',');
        console.log(`${parts[0]}: 开${parts[1]} 收${parts[2]} 高${parts[3]} 低${parts[4]} 涨跌${parts[8]}% 量${parts[5]}`);
      });
      
      const closes = klines.map(k => parseFloat(k.split(',')[2]));
      const vols = klines.map(k => parseFloat(k.split(',')[5]));
      const lastClose = closes[closes.length - 1];
      
      if (closes.length >= 60) {
        const ma5 = closes.slice(-5).reduce((a,b) => a+b, 0) / 5;
        const ma10 = closes.slice(-10).reduce((a,b) => a+b, 0) / 10;
        const ma20 = closes.slice(-20).reduce((a,b) => a+b, 0) / 20;
        const ma60 = closes.slice(-60).reduce((a,b) => a+b, 0) / 60;
        console.log(`MA5=${ma5.toFixed(2)} MA10=${ma10.toFixed(2)} MA20=${ma20.toFixed(2)} MA60=${ma60.toFixed(2)} 昨收=${lastClose}`);
        
        let maStatus = '';
        if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) maStatus = '多头排列 ✅';
        else if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) maStatus = '空头排列 🔴';
        else maStatus = `混合 ⚠️`;
        console.log(`均线: ${maStatus}`);
        
        // RSI(14)
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
          const change = closes[i] - closes[i-1];
          if (change > 0) gains += change;
          else losses -= change;
        }
        const rsi = losses === 0 ? 100 : 100 - 100 / (1 + (gains/14) / (losses/14));
        console.log(`RSI(14)=${rsi.toFixed(1)} ${rsi > 70 ? '🔴超买' : rsi < 30 ? '🟢超卖' : '✅正常'}`);
        
        // MACD
        const ema = (arr, period) => {
          const k = 2 / (period + 1);
          let e = arr[0];
          for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
          return e;
        };
        const difs = [];
        for (let i = 26; i <= closes.length; i++) {
          const slice = closes.slice(Math.max(0, i-35), i);
          const e12 = ema(slice, Math.min(12, slice.length));
          const e26 = ema(slice, Math.min(26, slice.length));
          difs.push(e12 - e26);
        }
        const dif = difs[difs.length - 1];
        const dea = ema(difs.slice(-9), Math.min(9, difs.length));
        const macd = (dif - dea) * 2;
        console.log(`MACD: DIF=${dif.toFixed(3)} DEA=${dea.toFixed(3)} MACD=${macd.toFixed(3)} ${dif > dea ? '✅金叉' : '🔴死叉'}`);
        
        // 布林带
        const last20 = closes.slice(-20);
        const mean = last20.reduce((a,b) => a+b, 0) / 20;
        const std = Math.sqrt(last20.reduce((a,b) => a + (b-mean)**2, 0) / 20);
        const upper = mean + 2*std, lower = mean - 2*std;
        console.log(`布林: 上${upper.toFixed(2)} 中${mean.toFixed(2)} 下${lower.toFixed(2)}`);
        
        // 量能
        const vol5 = vols.slice(-5).reduce((a,b) => a+b, 0) / 5;
        const vol20 = vols.slice(-20).reduce((a,b) => a+b, 0) / 20;
        const lastVol = vols[vols.length - 1];
        console.log(`量能: 最近${lastVol.toFixed(0)} 5日均${vol5.toFixed(0)} 20日均${vol20.toFixed(0)} ${lastVol < vol5*0.7 ? '🟢缩量' : lastVol > vol5*1.5 ? '🔴放量' : '正常'}`);
      }
      return klines;
    }
  } catch(e) { console.log(name + ' kline error:', e.message); }
  return null;
}

(async () => {
  // 1. A股指数
  console.log('========== A股三大指数（9:18竞价） ==========');
  try {
    const aUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f4,f5,f6,f12,f14&secids=1.000001,0.399001,0.399006';
    const aData = await fetch(aUrl);
    const aJson = JSON.parse(aData);
    if (aJson.data && aJson.data.diff) {
      aJson.data.diff.forEach(item => {
        console.log(`${item.f14}: 现价=${(item.f2/100).toFixed(2)} 涨跌=${(item.f3/100).toFixed(2)}% 成交额=${(item.f6/100000000).toFixed(0)}亿`);
      });
    }
  } catch(e) { console.log('指数error:', e.message); }

  // 2. 美股指数
  console.log('\n========== 美股隔夜表现 ==========');
  const usIdx = [
    {code:'100.NDX', name:'纳斯达克'},
    {code:'100.DJIA', name:'道琼斯'},
    {code:'100.SPX', name:'标普500'},
  ];
  for (const idx of usIdx) {
    try {
      const kurl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${idx.code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20260708&lmt=3`;
      const kdata = await fetch(kurl);
      const kjson = JSON.parse(kdata);
      if (kjson.data && kjson.data.klines) {
        console.log(`\n${idx.name}:`);
        kjson.data.klines.forEach(k => {
          const [d,o,c,h,l,v,a,p] = k.split(',');
          console.log(`  ${d}: 收${c} 涨跌${p}%`);
        });
      }
    } catch(e) { console.log(idx.name + ' error:', e.message); }
  }

  // 美股科技股
  console.log('\n--- 美股科技股隔夜 ---');
  const usTech = [
    {code:'105.NVDA', name:'英伟达'},
    {code:'105.AMD', name:'AMD'},
    {code:'105.AVGO', name:'博通'},
    {code:'105.MU', name:'美光'},
    {code:'105.TSM', name:'台积电'},
    {code:'105.AAPL', name:'苹果'},
  ];
  for (const s of usTech) {
    try {
      const kurl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${s.code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20260708&lmt=1`;
      const kdata = await fetch(kurl);
      const kjson = JSON.parse(kdata);
      if (kjson.data && kjson.data.klines && kjson.data.klines.length > 0) {
        const [d,o,c,h,l,v,a,p] = kjson.data.klines[0].split(',');
        console.log(`${s.name}: 收${c} 涨跌${p}%`);
      }
    } catch(e) { console.log(s.name + ' error:', e.message); }
  }

  // 3. 个股
  console.log('\n========== 关注个股 ==========');
  const stocks = [
    {secid:'0.002463', name:'沪电股份'},
    {secid:'1.002050', name:'三花智控'},
    {secid:'1.600487', name:'亨通光电'},
  ];
  for (const s of stocks) {
    await getStockRealtime(s.secid, s.name);
    await getKlines(s.secid, s.name, 60);
  }

  // 4. 汇率
  console.log('\n========== 人民币汇率 ==========');
  try {
    const fxUrl = 'https://push2.eastmoney.com/api/qt/stock/get?secid=119.USDCNY&fields=f43,f44,f45,f46,f57,f58,f60,f170';
    const fxData = await fetch(fxUrl);
    const fxJson = JSON.parse(fxData);
    if (fxJson.data) {
      console.log(`美元/人民币: ${fxJson.data.f43/100} 涨跌: ${fxJson.data.f170 !== null ? (fxJson.data.f170/100).toFixed(2) + '%' : 'N/A'}`);
    }
  } catch(e) { console.log('汇率error:', e.message); }

  // 5. 涨跌家数（竞价阶段）
  console.log('\n========== 涨跌家数（竞价） ==========');
  try {
    const listUrl = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fields=f3,f12&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
    const listData = await fetch(listUrl);
    const listJson = JSON.parse(listData);
    let up=0, down=0, flat=0, limitUp=0, limitDown=0;
    if (listJson.data && listJson.data.diff) {
      listJson.data.diff.forEach(s => {
        const pct = s.f3;
        if (pct > 0) up++;
        else if (pct < 0) down++;
        else flat++;
        if (pct >= 9.9) limitUp++;
        if (pct <= -9.9) limitDown++;
      });
    }
    console.log(`涨:${up} 跌:${down} 平:${flat} 涨停:${limitUp} 跌停:${limitDown}`);
  } catch(e) { console.log('涨跌error:', e.message); }

})();
