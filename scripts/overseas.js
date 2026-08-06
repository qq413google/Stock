#!/usr/bin/env node
/**
 * 隔夜外盘 beta 环境（开盘前播报）。
 * 拉美股三大指数 + 自建半导体篮子(费城半导体SOX东财此环境查无,用等权篮子代理)，
 * 给出 A股次日的"beta 环境"读数——解释开盘跳空是外盘带的、不是个股 alpha。
 *
 * ⛔ 红线(risk-management 第六·补节)：外盘数字**只做环境校准，绝不做买入理由**。
 *    "美股芯片涨→买中国芯片" 是当年"讲故事害亏1850"的死因，禁止。
 *
 * Usage: node overseas.js
 * 字段: f43=最新价 f58=名称 f170=涨跌幅(×100) —— beta 只需涨跌幅(f170/100)，不依赖价格标度
 */
const INDICES = [
  { secid: '100.NDX', name: '纳指100' },
  { secid: '100.SPX', name: '标普500' },
  { secid: '100.DJIA', name: '道琼斯' },
];
// 半导体篮子(费半代理)。105=NASDAQ, 106=NYSE。拉不到的自动跳过，用取到的等权平均。
const SEMIS = [
  { secid: '105.NVDA', name: '英伟达' },
  { secid: '105.AMD', name: 'AMD' },
  { secid: '105.MU', name: '美光' },
  { secid: '105.AVGO', name: '博通' },
  { secid: '105.INTC', name: '英特尔' },
  { secid: '105.AMAT', name: '应用材料' },
  { secid: '105.LRCX', name: '泛林' },
  { secid: '105.ASML', name: '阿斯麦' },
  { secid: '106.TSM', name: '台积电' },
];

async function getPct(secid) {
  const u = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f58,f170`;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Connection': 'close' } }).then(x => x.json());
      if (r && r.data && r.data.f170 != null) return { name: r.data.f58, pct: +r.data.f170 / 100 };
    } catch (e) { /* retry */ }
    await new Promise(s => setTimeout(s, 400 * (i + 1)));
  }
  return null;
}

(async () => {
  console.log('=== 隔夜外盘 beta 环境 ===');
  const idx = [];
  for (const o of INDICES) { const r = await getPct(o.secid); if (r) idx.push({ ...o, pct: r.pct }); }
  idx.forEach(x => console.log(`${x.name}: ${x.pct >= 0 ? '+' : ''}${x.pct.toFixed(2)}%`));

  const semi = [];
  for (const o of SEMIS) { const r = await getPct(o.secid); if (r) semi.push({ ...o, pct: r.pct }); }
  let semiAvg = null;
  if (semi.length) {
    semiAvg = semi.reduce((a, b) => a + b.pct, 0) / semi.length;
    const detail = semi.map(x => `${x.name}${x.pct >= 0 ? '+' : ''}${x.pct.toFixed(1)}`).join(' ');
    console.log(`半导体篮子(${semi.length}只等权,费半代理): ${semiAvg >= 0 ? '+' : ''}${semiAvg.toFixed(2)}%  [${detail}]`);
  } else {
    console.log('半导体篮子: 全部拉取失败(跳过)');
  }

  // beta 环境读数（仅环境，不做买入理由）
  const nasdaq = idx.find(x => x.secid === '100.NDX');
  const ndxPct = nasdaq ? nasdaq.pct : null;
  const drivers = [ndxPct, semiAvg].filter(x => x !== null);
  const envAvg = drivers.length ? drivers.reduce((a, b) => a + b, 0) / drivers.length : null;
  let env;
  if (envAvg === null) env = '⚠️ 外盘数据不足,无法判定';
  else if (envAvg >= 2) env = '🔥 隔夜外盘强势(科技/芯片) → A股科技链大概率高开顺风(beta)';
  else if (envAvg >= 0.5) env = '📈 隔夜外盘偏暖 → 温和 beta 顺风';
  else if (envAvg > -0.5) env = '🟡 隔夜外盘平淡 → beta 影响小';
  else if (envAvg > -2) env = '📉 隔夜外盘偏弱 → A股科技链或低开(beta)';
  else env = '🔴 隔夜外盘大跌 → 警惕低开;别在恐慌里接飞刀';
  console.log(`--- ${env} ---`);
  if (semiAvg !== null) console.log(`(芯片链尤其看半导体篮子 ${semiAvg >= 0 ? '+' : ''}${semiAvg.toFixed(2)}%;个股弹性≠指数)`);
  console.log('⛔ 外盘只做环境校准,不做买入理由(risk-management 第六·补节)。跳空多是beta,更该等10点确认,别把beta当alpha。');
})();
