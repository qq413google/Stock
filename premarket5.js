const https = require('https');
function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers: {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/'}}, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getK(secid, name) {
  try {
    const url = `https://quote.eastmoney.com/center/api/sidemenu.json?type=ks&secid=${secid}`;
    // 尝试另一个接口
    const url2 = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59&klt=101&fqt=1&end=20260708&lmt=60`;
    const data = await fetch(url2);
    const json = JSON.parse(data);
    if (json.data && json.data.klines) {
      const kl = json.data.klines;
      console.log(`\n--- ${name} ---`);
      kl.slice(-5).forEach(k => {
        const p = k.split(',');
        console.log(`${p[0]}: 开${p[1]} 收${p[2]} 高${p[3]} 低${p[4]} 涨跌${p[8]}% 量${p[5]}`);
      });
      
      const closes = kl.map(k => parseFloat(k.split(',')[2]));
      const vols = kl.map(k => parseFloat(k.split(',')[5]));
      const lc = closes[closes.length-1];
      
      const ma5 = closes.slice(-5).reduce((a,b)=>a+b,0)/5;
      const ma10 = closes.slice(-10).reduce((a,b)=>a+b,0)/10;
      const ma20 = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
      const ma60 = closes.slice(-60).reduce((a,b)=>a+b,0)/60;
      console.log(`MA5=${ma5.toFixed(2)} MA10=${ma10.toFixed(2)} MA20=${ma20.toFixed(2)} MA60=${ma60.toFixed(2)} 昨收=${lc}`);
      
      let maStr;
      if (ma5>ma10&&ma10>ma20&&ma20>ma60) maStr='多头排列 ✅';
      else if (ma5<ma10&&ma10<ma20&&ma20<ma60) maStr='空头排列 🔴';
      else maStr=`混合 ⚠️`;
      console.log(`均线: ${maStr}`);
      
      let g=0,l=0;
      for(let i=closes.length-14;i<closes.length;i++){const c=closes[i]-closes[i-1];if(c>0)g+=c;else l-=c;}
      const rsi=l===0?100:100-100/(1+(g/14)/(l/14));
      console.log(`RSI(14)=${rsi.toFixed(1)} ${rsi>70?'🔴超买':rsi<30?'🟢超卖':'✅正常'}`);
      
      const ema=(arr,p)=>{const k=2/(p+1);let e=arr[0];for(let i=1;i<arr.length;i++)e=arr[i]*k+e*(1-k);return e;};
      const difs=[];
      for(let i=26;i<=closes.length;i++){const sl=closes.slice(Math.max(0,i-35),i);difs.push(ema(sl,Math.min(12,sl.length))-ema(sl,Math.min(26,sl.length)));}
      const dif=difs[difs.length-1];
      const dea=ema(difs.slice(-9),Math.min(9,difs.length));
      const macd=(dif-dea)*2;
      console.log(`MACD: DIF=${dif.toFixed(3)} DEA=${dea.toFixed(3)} 柱=${macd.toFixed(3)} ${dif>dea?'✅金叉':'🔴死叉'}`);
      
      const l20=closes.slice(-20);
      const m=l20.reduce((a,b)=>a+b,0)/20;
      const sd=Math.sqrt(l20.reduce((a,b)=>a+(b-m)**2,0)/20);
      console.log(`布林: 上${(m+2*sd).toFixed(2)} 中${m.toFixed(2)} 下${(m-2*sd).toFixed(2)}`);
      
      const v5=vols.slice(-5).reduce((a,b)=>a+b,0)/5;
      const v20=vols.slice(-20).reduce((a,b)=>a+b,0)/20;
      const lv=vols[vols.length-1];
      console.log(`量能: 最近${lv.toFixed(0)} 5均${v5.toFixed(0)} 20均${v20.toFixed(0)} ${lv<v5*0.7?'🟢缩量':lv>v5*1.5?'🔴放量':'正常'}`);
    } else {
      console.log(`${name}: 无K线数据`);
    }
  } catch(e) { console.log(name+' error: '+e.message); }
}

(async () => {
  // 逐个拉，中间等一下
  await getK('0.002463', '沪电股份');
  await new Promise(r => setTimeout(r, 500));
  await getK('1.002050', '三花智控');
  await new Promise(r => setTimeout(r, 500));
  await getK('1.600487', '亨通光电');
  await new Promise(r => setTimeout(r, 500));
  await getK('1.000001', '上证指数');
})();
