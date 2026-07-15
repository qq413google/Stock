#!/usr/bin/env node
/**
 * 主力资金流向查询脚本（支持多日）
 * Usage: node flow.js <secid> [days]
 * Example: node flow.js 1.600487      # 当日(实时接口)
 *          node flow.js 1.600487 5     # 最近5日(历史接口)
 *
 * 单日(默认): push2.eastmoney.com → 实时当日数据
 * 多日(days>1): push2his.eastmoney.com/fflow/daykline → 历史资金流(额外含 f57主力净占比% + f58小单净占比%)
 *
 * 字段顺序(易错): f51日期,f52主力,f53小单,f54中单,f55大单,f56超大单
 * 校验恒等式: 主力 = 超大单 + 大单
 */
const secid = process.argv[2];
const days = parseInt(process.argv[3] || '1');
if (!secid) {
  console.error('Usage: node flow.js <secid> [days]');
  process.exit(1);
}

if (days <= 1) {
  // 单日：实时接口
  const url = `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=1&klt=101`;
  fetch(url).then(r => r.json()).then(d => {
    if (!d.data || !d.data.klines || !d.data.klines.length) {
      console.error('No data'); process.exit(1);
    }
    const line = d.data.klines[d.data.klines.length - 1];
    const p = line.split(',');
    const main = +p[1] / 1e8, small = +p[2] / 1e8, medium = +p[3] / 1e8, large = +p[4] / 1e8, superL = +p[5] / 1e8;
    // 恒等式校验
    const err = Math.abs(main - (superL + large));
    const pass = err < 0.01;
    console.log(`${d.data.name} 资金流向(亿): 主力=${main.toFixed(2)} 超大单=${superL.toFixed(2)} 大单=${large.toFixed(2)} 中单=${medium.toFixed(2)} 小单=${small.toFixed(2)} | 恒等式${pass ? '✅' : '🔴误差=' + err.toFixed(4)}`);
    // 禁买清单"主力当日净流出"自动判定（实时口径，今日盘中）
    console.log(main < 0
      ? `🔴 禁买判定: 当日主力净流出 ${main.toFixed(2)}亿 → 触发禁买清单"主力净流出"，不接`
      : `✅ 当日主力净流入 ${main.toFixed(2)}亿 → 该项禁买不触发`);
    if (!pass) console.error('⚠️ 恒等式校验失败，数据可能有bug，暂停使用！');
  });
} else {
  // 多日：历史接口
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=${days}&klt=101`;
  fetch(url).then(r => r.json()).then(d => {
    if (!d.data || !d.data.klines || !d.data.klines.length) {
      console.error('No data'); process.exit(1);
    }
    const ks = d.data.klines;
    console.log(`${d.data.name || secid} 主力资金流向(${ks.length}日):`);
    let mainSum = 0;
    let allPass = true;
    ks.forEach(line => {
      const p = line.split(',');
      const date = p[0];
      const main = +p[1] / 1e8, small = +p[2] / 1e8, medium = +p[3] / 1e8, large = +p[4] / 1e8, superL = +p[5] / 1e8;
      const mainRatio = p[6]; // f57=主力净占比%(主力净额/成交额)，非涨跌幅
      mainSum += main;
      const err = Math.abs(main - (superL + large));
      const pass = err < 0.01;
      if (!pass) allPass = false;
      console.log(`${date} 主力=${main.toFixed(2)} 超大单=${superL.toFixed(2)} 大单=${large.toFixed(2)} 中单=${medium.toFixed(2)} 小单=${small.toFixed(2)} 主力净占比=${mainRatio}% | 恒等式${pass ? '✅' : '🔴'}`);
    });
    // 最近连续净流入/流出天数（从最新往前数）
    let dir = 0, cnt = 0;
    for (let i = ks.length - 1; i >= 0; i--) {
      const m = +ks[i].split(',')[1];
      const s = Math.sign(m);
      if (dir === 0) { dir = s; cnt = 1; }
      else if (s === dir && s !== 0) { cnt++; }
      else break;
    }
    const dirTxt = dir > 0 ? '净流入' : dir < 0 ? '净流出' : '平';
    console.log(`--- ${ks.length}日合计主力 ${mainSum.toFixed(2)}亿 | 最近连续 ${cnt} 日${dirTxt} | 恒等式${allPass ? '✅全部通过' : '🔴有失败'} ---`);
    // 资金面趋势判定（多日daykline截至上一交易日收盘）
    const lastP = ks[ks.length - 1].split(',');
    const lastDate = lastP[0], lastMain = +lastP[1] / 1e8, lastRatio = lastP[6];
    let verdict;
    if (lastMain < 0 && dir < 0 && cnt >= 2) {
      verdict = `🔴 资金面: ${lastDate}收盘主力净流出(净占比${lastRatio}%)，连续${cnt}日净流出 → 资金面持续走弱，强烈倾向禁买`;
    } else if (lastMain < 0) {
      verdict = `🟠 资金面: ${lastDate}收盘主力净流出(净占比${lastRatio}%)，但未连续 → 偏空`;
    } else if (dir > 0 && cnt >= 2) {
      verdict = `✅ 资金面: 连续${cnt}日主力净流入 → 资金面走强`;
    } else {
      verdict = `🟡 资金面: 方向反复，无连续性`;
    }
    console.log(verdict);
    console.log(`(多日数据截至上一交易日收盘；今日盘中当日方向请跑: node scripts/flow.js ${secid})`);
    if (!allPass) console.error('⚠️ 恒等式校验失败，数据可能有bug！');
  });
}
