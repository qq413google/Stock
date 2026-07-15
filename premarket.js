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
  // 1. A股三大指数实时
  console.log('========== A股三大指数 ==========');
  const aIndices = [
    {code:'1.000001', name:'上证指数'},
    {code:'0.399001', name:'深证成指'},
    {code:'0.399006', name:'创业板指'},
  ];
  const aSecids = aIndices.map(i => i.code).join(',');
  const aUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f1,f2,f3,f4,f5,f6,f7,f8,f10,f12,f14&secids=' + aSecids;
  try {
    const aData = await fetch(aUrl);
    const aJson = JSON.parse(aData);
    if (aJson.data && aJson.data.diff) {
      aJson.data.diff.forEach(item => {
        const price = item.f2 / 100;
        const pct = item.f3 / 100;
        const amt = item.f6 / 100000000;
        console.log(`${item.f14}: 现价=${price.toFixed(2)} 涨跌幅=${pct.toFixed(2)}% 成交额=${amt.toFixed(0)}亿`);
      });
    } else {
      console.log('A股指数raw:', aData.substring(0, 500));
    }
  } catch(e) { console.log('A股指数error:', e.message); }

  // 2. 美股指数（昨日收盘）
  console.log('\n========== 美股指数（隔夜） ==========');
  const usIndices = [
    {code:'100.NDX', name:'纳斯达克综合'},
    {code:'100.DJIA', name:'道琼斯工业'},
    {code:'100.SPX', name:'标普500'},
    {code:'100.SOX', name:'费城半导体'},
  ];
  for (const idx of usIndices) {
    try {
      const kurl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${idx.code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20260708&lmt=3`;
      const kdata = await fetch(kurl);
      const kjson = JSON.parse(kdata);
      if (kjson.data && kjson.data.klines) {
        console.log(`\n--- ${idx.name} ---`);
        kjson.data.klines.forEach(k => {
          const [date, open, close, high, low, vol, amount, pct] = k.split(',');
          console.log(`${date}: 开${open} 收${close} 高${high} 低${low} 涨跌${pct}%`);
        });
      } else {
        console.log(`${idx.name}: 无K线数据, raw:`, kdata.substring(0, 300));
      }
    } catch(e) { console.log(idx.name + ' error:', e.message); }
  }

  // 3. 涨跌家数统计
  console.log('\n========== A股涨跌家数 ==========');
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
    console.log(`总股票: ${listJson.data ? listJson.data.total : '?'}`);
    console.log(`涨: ${up}, 跌: ${down}, 平: ${flat}`);
    console.log(`涨停: ${limitUp}, 跌停: ${limitDown}`);
    console.log(`涨跌比: ${down > 0 ? (up/down).toFixed(2) : 'N/A'}`);
  } catch(e) { console.log('涨跌家数error:', e.message); }

  // 4. 用户关注个股 - 沪电股份、三花智控
  console.log('\n========== 关注个股实时 ==========');
  const stocks = [
    {code:'2.002463', name:'沪电股份'},
    {code:'1.002050', name:'三花智控'},
    {code:'2.600288', name:'亨通光电'},
  ];
  const sSecids = stocks.map(s => s.code).join(',');
  const sUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f4,f5,f6,f7,f8,f10,f12,f14,f15,f16,f17&secids=' + sSecids;
  try {
    const sData = await fetch(sUrl);
    const sJson = JSON.parse(sData);
    if (sJson.data && sJson.data.diff) {
      sJson.data.diff.forEach(item => {
        const price = item.f2 / 100;
        const pct = item.f3 / 100;
        console.log(`${item.f14}: 现价=${price.toFixed(2)} 涨跌=${pct.toFixed(2)}% 最高=${(item.f15/100).toFixed(2)} 最低=${(item.f16/100).toFixed(2)} 成交额=${(item.f6/100000000).toFixed(2)}亿`);
      });
    } else {
      console.log('个股raw:', sData.substring(0, 500));
    }
  } catch(e) { console.log('个股error:', e.message); }

  // 5. 板块涨幅排行
  console.log('\n========== 板块涨幅TOP10 ==========');
  try {
    const bUrl = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fields=f2,f3,f4,f12,f14&fs=m:90+t:2';
    const bData = await fetch(bUrl);
    const bJson = JSON.parse(bData);
    if (bJson.data && bJson.data.diff) {
      bJson.data.diff.forEach((item, i) => {
        console.log(`${i+1}. ${item.f14}: 涨幅=${(item.f3/100).toFixed(2)}% 现价=${(item.f2/100).toFixed(2)}`);
      });
    }
  } catch(e) { console.log('板块error:', e.message); }

  console.log('\n========== 板块跌幅TOP5 ==========');
  try {
    const bUrl2 = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=0&np=1&fltt=2&invt=2&fields=f2,f3,f4,f12,f14&fs=m:90+t:2';
    const bData2 = await fetch(bUrl2);
    const bJson2 = JSON.parse(bData2);
    if (bJson2.data && bJson2.data.diff) {
      bJson2.data.diff.forEach((item, i) => {
        console.log(`${i+1}. ${item.f14}: 跌幅=${(item.f3/100).toFixed(2)}%`);
      });
    }
  } catch(e) { console.log('板块跌幅error:', e.message); }

})();
