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
  // 成交额(f48)用于"量级校验"——恒等式抓不到整体×10这类scale错误(10a=10b+10c仍成立),
  // 但净占比(主力/成交额)会飙到离谱,可抓出来。带重试+Connection:close(规避undici连坏socket)。
  const qUrl = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f48,f58`;
  const getJson = async (u) => {
    for (let i = 0; i < 4; i++) {
      try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Connection': 'close' } }).then(x => x.json()); if (r && r.data) return r; } catch (e) { /* retry */ }
      await new Promise(s => setTimeout(s, 400 * (i + 1)));
    }
    return null;
  };
  (async () => {
    const d = await getJson(url);
    if (!d || !d.data || !d.data.klines || !d.data.klines.length) { console.error('No data'); process.exit(1); }
    const p = d.data.klines[d.data.klines.length - 1].split(',');
    const main = +p[1] / 1e8, small = +p[2] / 1e8, medium = +p[3] / 1e8, large = +p[4] / 1e8, superL = +p[5] / 1e8;
    // 恒等式1: 主力 = 超大 + 大
    const err1 = Math.abs(main - (superL + large)), pass1 = err1 < 0.01;
    // 恒等式2: 超大 + 大 + 中 + 小 = 0 (四类净额闭合;实测全成立,能抓到更多字段错位)
    const err2 = Math.abs(superL + large + medium + small), pass2 = err2 < 0.01;
    const idOk = pass1 && pass2;
    console.log(`${d.data.name} 资金流向(亿): 主力=${main.toFixed(2)} 超大单=${superL.toFixed(2)} 大单=${large.toFixed(2)} 中单=${medium.toFixed(2)} 小单=${small.toFixed(2)} | 恒等式${idOk ? '✅' : '🔴'}`);
    if (!pass1) console.error(`⚠️ 恒等式1(主力=超大+大)失败 误差=${err1.toFixed(4)}`);
    if (!pass2) console.error(`⚠️ 恒等式2(超大+大+中+小=0)失败 误差=${err2.toFixed(4)} → 疑字段错位/数据bug`);
    // 量级校验(best-effort): 成交额取到才做,取不到只跳过不报错
    const q = await getJson(qUrl);
    if (q && q.data && q.data.f48 != null && +q.data.f48 > 0) {
      const amt = +q.data.f48 / 1e8;                 // 成交额(亿)
      const ratio = main / amt * 100;                // 主力净占比%
      const impossible = Math.abs(main) > amt;       // 净额>成交额=物理上不可能
      const magBad = Math.abs(ratio) > 60;           // 净占比>60%极罕见
      console.log(`量级校验: 成交额${amt.toFixed(2)}亿 主力净占比${ratio >= 0 ? '+' : ''}${ratio.toFixed(1)}% ${impossible ? '🔴净额>成交额,不可能→数据错(疑×10/错位)' : magBad ? '🔴净占比>60%异常,存疑' : '✅合理'}`);
      if (impossible || magBad) console.error('⚠️ 量级校验异常,数据可能有bug,暂停据此判断！');
    } else {
      console.log('量级校验: 成交额未取到 → 跳过(仅恒等式已过)');
    }
    // 禁买清单"主力当日净流出"自动判定（实时口径，今日盘中）
    console.log(main < 0
      ? `🔴 禁买判定: 当日主力净流出 ${main.toFixed(2)}亿 → 触发禁买清单"主力净流出"，不接`
      : `✅ 当日主力净流入 ${main.toFixed(2)}亿 → 该项禁买不触发`);
    if (!idOk) console.error('⚠️ 恒等式校验失败，数据可能有bug，暂停使用！');
  })();
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
