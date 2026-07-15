/**
 * 研究 H + G: 超大单override门槛 + 资金动能递减
 * 方法论同 D/E: fwdReturn 分桶对比, 不走 simulatePortfolio.
 * 缓存优先(30只自选股已在 cache/backtest/), 离线可跑。
 */
const L = require('./lib.js');
const fs = require('fs');
const path = require('path');
const WL = require('../watchlist.json').stocks;

const fmtPct = n => (n === null || n === undefined || isNaN(n)) ? 'N/A' : (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const fmtNum = n => (n === null || n === undefined || isNaN(n)) ? 'N/A' : n.toFixed(2);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const hit  = a => a.length ? a.filter(x => x < 0).length / a.length : NaN;

async function run() {
  // 从缓存加载（并发=3, 不触发 API。缓存已全，加载不会失败）
  console.log('从缓存加载自选股...');
  const all = await L.pool(WL, async s => {
    try { const rows = await L.loadStock(s.secid, { klineLmt: 600, flowLmt: 120, clipToFlow: true }); return { ...s, rows }; }
    catch (e) { return { ...s, rows: [], err: String(e) }; }
  }, 3);
  const stocks = all.filter(s => s.rows.length > 60);
  console.log(`加载完成: ${stocks.length}/${WL.length} 只有效\n`);

  // ================================================================
  // 研究 H: 超大单 override 门槛按幅度/趋势分级
  // ================================================================
  console.log('========== 研究H: 超大单override门槛按幅度分级 ==========');
  console.log('场景: 主力净流出(main<-0.3) + 多头(站MA20+MA60) + 超大单override');
  console.log('问题: 超大单"刚过零线"的override vs "明显为正"的override, 说服力差多少?\n');

  const H = {
    override_strong: [],   // superL >= 2.0
    override_mid:    [],   // 0.5 ~ 2.0
    override_weak:   [],   // 0 ~ 0.5
    no_override:     [],   // superL <= 0 (对照组: 主力流出且超大单也负, 不做override的场景)
  };

  for (const s of stocks) {
    const r = s.rows;
    for (let i = 1; i < r.length; i++) {
      const c = r[i];
      // 条件: 主力净流出 + 多头趋势
      if (!(c.main < 0)) continue;           // 主力净流出
      if (!c.ma20 || !c.ma60) continue;       // 均线不完整
      if (!(c.c > c.ma20) || !(c.c > c.ma60)) continue; // 不站多头趋势
      // 不追高
      if (!(c.c < (c.ma5 || c.c * 2) * 1.01)) continue;

      const superVal = c.superL || 0;
      const f1 = L.fwdReturn(r, i, 1);
      const f3 = L.fwdReturn(r, i, 3);
      const f5 = L.fwdReturn(r, i, 5);
      if (f5 == null) continue;

      const entry = { f1, f3, f5, date: c.date, superL: superVal, main: c.main };
      if (superVal >= 2.0)        H.override_strong.push(entry);
      else if (superVal >= 0.5)   H.override_mid.push(entry);
      else if (superVal > 0)      H.override_weak.push(entry);
      else                        H.no_override.push(entry);
    }
  }

  const hBuckets = [
    { key: '超大单≥2亿(强override)', arr: H.override_strong },
    { key: '超大单0.5~2亿(中override)', arr: H.override_mid },
    { key: '超大单0~0.5亿(弱override)', arr: H.override_weak },
    { key: '超大单≤0(不override)', arr: H.no_override },
  ];

  for (const b of hBuckets) {
    const a = b.arr;
    console.log(`${b.key}:`);
    console.log(`  n=${a.length}  1日=${fmtPct(mean(a.map(x=>x.f1)))}  3日=${fmtPct(mean(a.map(x=>x.f3)))}  5日=${fmtPct(mean(a.map(x=>x.f5)))}`);
    console.log(`  下跌率: 1日=${fmtPct(hit(a.map(x=>x.f1)))}  3日=${fmtPct(hit(a.map(x=>x.f3)))}  5日=${fmtPct(hit(a.map(x=>x.f5)))}`);
  }

  // 结论: 弱override的5日均值 vs 强override的差异
  const weak5 = mean(H.override_weak.map(x => x.f5));
  const strong5 = mean(H.override_strong.map(x => x.f5));
  const noOverride5 = mean(H.no_override.map(x => x.f5));
  console.log('');
  if (H.override_weak.length > 0 && H.override_strong.length > 0) {
    const delta = weak5 - strong5;
    console.log(`强override(≥2亿) 5日均值=${fmtPct(strong5)} vs 弱override(0~0.5亿)=${fmtPct(weak5)} → 差值=${fmtPct(delta)}`);
    const verdict = delta < -0.005
      ? '弱override后续显著差于强override → 建议提高override门槛(≥0.5亿或≥2亿才信任override)'
      : delta < 0
        ? '弱override略差于强override → 建立gradual信心, 弱override建议配合其他信号'
        : '弱override不比强override差 → 当前"正负阈值"已足够, 幅度分级无增量信息';
    console.log(`结论: ${verdict}`);
  }

  // ================================================================
  // 研究 G: 资金动能递减信号
  // ================================================================
  console.log('\n========== 研究G: 资金动能递减信号 ==========');
  console.log('问题: 5日主力流入斜率递减(加速→持平→减速→转负), 后续表现如何?\n');

  // 对每个交易日, 找 it 且有前5日 flow 数据的点(需要 main 字段连续5日非 nan)
  // 算法: 最近5日 main 值做线性回归, x=[1,2,3,4,5], y=[main_t4, main_t3, ..., main_t0]
  const G = {
    base: [],           // 所有有5日连续flow数据的交易日
    accel: [],          // 5日sum>0, slope>+0.1 (加速流入)
    flat: [],           // 5日sum>0, slope∈[-0.1,+0.1] (持平)
    decel: [],          // 5日sum>0, slope<-0.1 (减速流入)
    decel_neg: [],      // 5日sum>0, slope<-0.1, 且当日main<0 (减速+转负, 紫光国微型)
  };

  function slope5(arr) {
    // 简单线性回归: 5点
    const n = 5;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let i = 0; i < n; i++) {
      sx += (i + 1);
      sy += arr[i];
      sxy += (i + 1) * arr[i];
      sx2 += (i + 1) * (i + 1);
    }
    return (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  }

  for (const s of stocks) {
    const r = s.rows;
    for (let i = 0; i < r.length; i++) {
      // 确保前5日main都非nan
      if (i < 4) continue;
      const last5 = [];
      let allOk = true;
      for (let j = i - 4; j <= i; j++) {
        if (r[j].main === undefined || r[j].main === null || isNaN(r[j].main)) {
          allOk = false; break;
        }
        last5.push(r[j].main);
      }
      if (!allOk || last5.length < 5) continue;

      const sum5 = last5.reduce((a, b) => a + b, 0);
      const slp = slope5(last5);
      const todayMain = r[i].main;

      const f1 = L.fwdReturn(r, i, 1);
      const f3 = L.fwdReturn(r, i, 3);
      const f5 = L.fwdReturn(r, i, 5);
      if (f5 == null) continue;

      G.base.push({ f1, f3, f5, sum5, slp, todayMain });

      // 只看"5日总体净流入"的场景(才能讨论"递减")
      if (sum5 <= 2) continue;

      const entry = { f1, f3, f5, sum5: sum5.toFixed(2), slope: slp.toFixed(4), todayMain };
      if (slp > 0.1) {
        G.accel.push(entry);
      } else if (slp >= -0.1) {
        G.flat.push(entry);
      } else {
        G.decel.push(entry);
        if (todayMain < 0) G.decel_neg.push(entry);
      }
    }
  }

  // 基准
  console.log(`基准(全部5日连续flow窗口):`);
  console.log(`  n=${G.base.length}  1日=${fmtPct(mean(G.base.map(x=>x.f1)))}  3日=${fmtPct(mean(G.base.map(x=>x.f3)))}  5日=${fmtPct(mean(G.base.map(x=>x.f5)))}`);
  console.log(`  下跌率: 1日=${fmtPct(hit(G.base.map(x=>x.f1)))}  3日=${fmtPct(hit(G.base.map(x=>x.f3)))}  5日=${fmtPct(hit(G.base.map(x=>x.f5)))}`);

  const gBuckets = [
    { key: '加速流入(slope>+0.1)', arr: G.accel },
    { key: '持平(-0.1~+0.1)', arr: G.flat },
    { key: '减速流入(slope<-0.1)', arr: G.decel },
    { key: '减速+当日转负(slope<-0.1,main<0,紫光型)', arr: G.decel_neg },
  ];

  console.log('\n仅看"5日合计>2亿"的显著净流入场景:');
  for (const b of gBuckets) {
    const a = b.arr;
    if (a.length === 0) { console.log(`${b.key}: n=0`); continue; }
    console.log(`${b.key}:`);
    console.log(`  n=${a.length}  1日=${fmtPct(mean(a.map(x=>x.f1)))}  3日=${fmtPct(mean(a.map(x=>x.f3)))}  5日=${fmtPct(mean(a.map(x=>x.f5)))}`);
    console.log(`  下跌率: 1日=${fmtPct(hit(a.map(x=>x.f1)))}  3日=${fmtPct(hit(a.map(x=>x.f3)))}  5日=${fmtPct(hit(a.map(x=>x.f5)))}`);
  }

  // 结论: 递减组 vs 加速组
  if (G.decel.length > 0 && G.accel.length > 0) {
    const decel5 = mean(G.decel.map(x => x.f5));
    const accel5 = mean(G.accel.map(x => x.f5));
    const flat5 = mean(G.flat.map(x => x.f5));
    const decelNeg5 = G.decel_neg.length ? mean(G.decel_neg.map(x => x.f5)) : NaN;
    console.log('');
    const deltaGA = decel5 - accel5;
    console.log(`加速流入 5日均值=${fmtPct(accel5)} vs 持平=${fmtPct(flat5)} vs 减速=${fmtPct(decel5)}`);
    if (!isNaN(decelNeg5)) console.log(`紫光型(减速+当日转负) 5日均值=${fmtPct(decelNeg5)}`);
    const gVerdict = deltaGA < -0.005
      ? '减速组后续显著差于加速组 → 资金动能递减是独立有效信号, 建议纳入风险提示'
      : deltaGA < 0
        ? '减速组略差于加速组但差异不够显著 → 可作为软提醒, 不单独当作闸门'
        : '递减组不比加速组差 → 5日斜率变化不预测后续方向, 可能是噪声';
    console.log(`结论: ${gVerdict}`);
    if (!isNaN(decelNeg5)) {
      const deltaDN = decelNeg5 - accel5;
      console.log(`紫光型(递减+当日转负) vs 加速: delta=${fmtPct(deltaDN)} ${deltaDN < -0.01 ? '→ 紫光型组合信号明显更差, 应作为独立警示' : '→ 差异不大'}`);
    }
  }

  // 写入结果
  const results = { meta: { date: new Date().toISOString(), stockCount: stocks.length }, H, G };
  // 简化输出(去掉大数组, 只保留统计数据)
  const summary = {
    meta: { date: new Date().toISOString(), stockCount: stocks.length },
    H: Object.fromEntries(Object.entries(H).map(([k, v]) => [k, {
      n: v.length,
      f1: mean(v.map(x => x.f1)), f3: mean(v.map(x => x.f3)), f5: mean(v.map(x => x.f5)),
      down1: hit(v.map(x => x.f1)), down3: hit(v.map(x => x.f3)), down5: hit(v.map(x => x.f5)),
    }])),
    G: {
      base: { n: G.base.length, f1: mean(G.base.map(x=>x.f1)), f3: mean(G.base.map(x=>x.f3)), f5: mean(G.base.map(x=>x.f5)),
              down1: hit(G.base.map(x=>x.f1)), down3: hit(G.base.map(x=>x.f3)), down5: hit(G.base.map(x=>x.f5)) },
      // 用G对象自身的稳定英文key(accel/flat/decel/decel_neg), 不再用中文桶名清洗成正则key
      // (旧写法 b.key.replace(/[^\w]/g,'_') 会把"加速流入(slope>+0.1)"和"减速流入(slope<-0.1)"清洗成同一个字符串, 导致后者覆盖前者、丢数据)
      ...Object.fromEntries(Object.entries({ accel: G.accel, flat: G.flat, decel: G.decel, decel_neg: G.decel_neg }).map(([k, arr]) => [k, {
        n: arr.length,
        f1: mean(arr.map(x=>x.f1)), f3: mean(arr.map(x=>x.f3)), f5: mean(arr.map(x=>x.f5)),
        down1: hit(arr.map(x=>x.f1)), down3: hit(arr.map(x=>x.f3)), down5: hit(arr.map(x=>x.f5)),
      }])),
    },
  };
  fs.writeFileSync(path.join(__dirname, 'results_hg.json'), JSON.stringify(summary, null, 2));
  console.log('\n✅ 结果已写入 backtest/results_hg.json');
}
run();
