#!/usr/bin/env node
/**
 * 持仓自动布防（对称于 arm-alerts.js 的"买入布防"，补上"卖出/止损布防"这一半）。
 * 读 positions.json，为每只持仓生成触发器写进 alerts.json：
 *   1. 硬止损 (sell:true)      = 写下的止损价(无则成本×0.92)，op '<=' —— 不依赖网络，永远布上（安全网）
 *   2. 移动止损 MA10 (sell:true) = 仅当浮盈≥5% 且 现价>MA10 时布，op '<=' —— 保护利润(edge 出场：趋势票让利润跑到破 MA10 才走)
 *   3. 加仓观察 (buy)          = 成本×1.05，op '>' —— 浮盈≥5% 向上金字塔加(严禁向下摊薄)
 *
 * 幂等：每次先删掉旧的 posauto:true 条目，保留 manual / watchlist 自动条目，再写入新的。
 * 由 check-alerts.ps1 每日刷新时在 arm-alerts.js 之后调用；也可手动:
 *   node scripts/arm-positions.js         (写入)
 *   node scripts/arm-positions.js --dry   (只预览)
 *
 * ⚠️ 触发只代表"价到了"，卖/加仍须人工过闸门(v2.6 开盘噪声窗 / 放量破位确认 / 盈亏比)。
 */
const fs = require('fs');
const path = require('path');
const DRY = process.argv.includes('--dry');
const root = path.join(__dirname, '..');
const posFile = path.join(root, 'positions.json');
const alertsFile = path.join(root, 'alerts.json');

// secid(0.xxxxxx / 1.xxxxxx) -> tencent(szxxxxxx / shxxxxxx)
function toTencent(secid) {
  const [mk, code] = String(secid).split('.');
  return (mk === '0' ? 'sz' : 'sh') + code;
}

// 拉近30日收盘（带重试 + Connection:close，规避 undici 连接池复用坏 socket）
// 返回 { closes, dates } —— dates 用于定位买入日，把移动止损的峰值限定在持仓期间
async function getCloses(secid) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=60`;
  for (let i = 0; i < 5; i++) {
    try {
      const k = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Connection': 'close' } }).then(r => r.json());
      const rows = ((k.data && k.data.klines) || []).map(L => { const p = L.split(','); return { date: p[0], c: +p[2] }; });
      if (rows.length >= 10) return { closes: rows.map(r => r.c), dates: rows.map(r => r.date) };
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  return null;
}
const ma = (cl, p) => cl.slice(-p).reduce((a, b) => a + b, 0) / p;
function bj() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' (北京)'; }

(async () => {
  const cfg = JSON.parse(fs.readFileSync(posFile, 'utf8'));
  const pos = cfg.持仓 || [];

  // 读现有 alerts.json，保留非 posauto 的条目(manual + watchlist 自动)
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(alertsFile, 'utf8')); } catch (e) { obj = {}; }
  const keep = (obj.alerts || []).filter(a => a.posauto !== true);

  const gen = [];
  const log = [];
  const stopUpdates = [];   // 移动止损上移后需回写 positions.json 的记录(防K线失败时退回)
  for (const p of pos) {
    const ten = toTencent(p.代码);
    const cost = +p.成本价;
    const hardCap = +(cost * 0.92).toFixed(2);
    const stopPx = p.止损价 ? +(+p.止损价).toFixed(2) : hardCap;

    // 1. 硬止损（不依赖网络，安全网必布）
    gen.push({
      name: `${p.标的}[持仓-止损]`, tencent: ten, op: '<=', price: stopPx,
      msg: `🔴止损线到 - 成本${cost}/止损${stopPx}。放量破位或10点后仍在下方即按纪律清,不留隔夜(灾难线-8%=${hardCap})。触发=该卖,ping Claude复核`,
      enabled: true, posauto: true, sell: true
    });

    // 3. 加仓观察（不依赖网络）。v2.8: 单票最多加1次——已加过(已加仓:true)就不再布，
    //    否则加仓后成本抬高、×1.05 又生成一条新线，会诱导二次加仓(违反金字塔单次原则)。
    const addPx = +(cost * 1.05).toFixed(2);
    // v2.10(2026-08-12): 加仓自身必须过盈亏比闸门。"成本×1.05"是机械公式,不看目标位还剩
    // 多少空间——目标位距成本不足+11%时,加仓线会挤在目标位旁边(京东方实例:加仓线6.24 vs
    // 目标6.30,加仓盈亏比仅0.125)。设了目标价且不达标 → 干脆不布线,免得弹了也不能用。
    // 未设目标价的趋势票(靠移动止损让利润跑,本就不预设目标)不受影响。
    let addRR = null;
    if (p.目标价 > 0 && addPx > stopPx) addRR = (p.目标价 - addPx) / (addPx - stopPx);
    if (p.已加仓 === true) {
      log.push(`${p.标的} 已加仓过(v2.8单票限1次)→不布加仓观察`);
    } else if (addRR !== null && addRR < 2) {
      log.push(`${p.标的} 加仓盈亏比${addRR.toFixed(2)}<2(加仓价${addPx}/目标${p.目标价}/止损${stopPx})→v2.10不布加仓观察`);
    } else {
      gen.push({
        name: `${p.标的}[持仓-加仓观察]`, tencent: ten, op: '>', price: addPx,
        msg: `📈浮盈≥5%(成本×1.05=${addPx})加仓观察${addRR !== null ? `,加仓盈亏比${addRR.toFixed(1)}` : ''} - 仅趋势完好+站稳MA10+回踩形态优先(v2.9b)金字塔加(减量),严禁向下摊薄。触发=价到,ping Claude过闸门`,
        enabled: true, posauto: true
      });
    }

    // 4. 冲高回落止盈（risk-management 第五节3 v2.11：日内涨>7%后从高点回落>2% → 减半锁利）
    //    2026-08-11 补：此前盯盘只有"止损/移动止损/加仓观察"三类，**没有任何止盈触发器**，
    //    导致 8/10 泰格日内冲 +5.70%(57.45) 后回落 -5.97%，明确满足减半锁利条件却全程无人提起
    //    （当时注意力全在"该不该加仓"上，加仓讨论挤掉了持仓例行检查）。少赚约155元事小，
    //    规则被系统性忽略事大 → 做成自动触发器。
    //    这条不是固定价位线，需盘中实时算(当日涨幅 + 从高点回落%)，故标 spikeFade:true，
    //    由 check-alerts.ps1 用专门逻辑判定；price 仅占位。
    //    仅 ≥200股(能真正减半)才布；100股(1手)无法减半，布了只会产生无法执行的噪声弹窗。
    if (p.股数 >= 200) {
      const halfLots = Math.floor(p.股数 / 2 / 100) * 100;
      gen.push({
        name: `${p.标的}[持仓-冲高回落止盈]`, tencent: ten, op: 'spike', price: 0,
        msg: `📉冲高回落止盈(日内涨>7%后从高点回落>2%,第五节3 v2.11) - 减半锁利:卖${halfLots}股,留${p.股数 - halfLots}股转移动止损。触发=该减仓,ping Claude复核`,
        enabled: true, posauto: true, sell: true, spikeFade: true
      });
    }

    // 2. 移动止损 MA10（需拉K线；失败只跳过，硬止损已兜底）
    //
    // 2026-08-11 修复：原条件含 `浮盈≥5%`，加仓后加权成本抬高会把浮盈稀释掉，
    // 导致移动止损**停止跟踪 MA10**、利润保护倒退——与 v2.9「加仓后维持原止损，
    // 移动止损照常跟 MA10 爬」直接冲突。实例：泰格首仓49.80时浮盈13%、止损已跟到51.04；
    // 加仓后加权成本53.25、浮盈掉到2.1%，MA10已爬到51.49却不再上移。
    // 浮盈门槛本就是多余的第二把锁——`m10 > stopPx` 已保证**只升不降**（永不放宽），
    // `price > m10` 保证不会布出一条立刻触发的线。两条足够安全，故去掉浮盈门槛。
    const kl = await getCloses(p.代码);
    if (kl) {
      const cl = kl.closes, dates = kl.dates;
      const price = cl[cl.length - 1];
      const m10 = +ma(cl, 10).toFixed(2);
      const pl = (price - cost) / cost;

      // 2026-08-12 修复：实盘只用了 MA10，**漏掉回测 baseline 里的另两条移动止损**，
      // 导致实盘止损长期比回测口径宽。研究L的 baseline(总盈亏112,960/回撤22.9%)用的是：
      //     if (浮盈>=5%) { stop = max(stop, 成本); stop = max(stop, 最高价*0.93); }
      // 泰格实例: 成本53.25、最高57.45 → 回测口径止损 max(53.25, 53.43)=53.43，
      // 而实盘布的 MA10=51.86，松了1.57元(3%)——等于一直在跑一个没被回测验证过的宽止损。
      // 现补齐：只要曾达浮盈≥5%，止损同时受"保本位"和"最高价回撤7%"约束，三者取最高。
      // ⚠️ peak 必须是**持仓期间**的最高收盘(回测里 pos.highest 从买入日开始累积)。
      //    2026-08-12 首版误用"近40日最高"，京东方因此算出 7/2 买入前的高点9.10×0.93=8.46,
      //    远高于现价——幸有 price>trailPx 检查挡住才没布出离谱止损。
      const buyIdx = dates.indexOf(p.买入日);
      const held = buyIdx >= 0 ? cl.slice(buyIdx) : cl.slice(-1);   // 找不到买入日则退化为仅当日
      const peak = Math.max(...held);
      const everProfit = (peak - cost) / cost >= 0.05;   // 持仓期间收盘浮盈曾达5%(与回测口径一致)
      let trailPx = m10;
      const parts = [`MA10=${m10}`];
      if (everProfit) {
        trailPx = Math.max(trailPx, cost, +(peak * 0.93).toFixed(2));
        parts.push(`保本=${cost}`, `峰值${peak}x0.93=${(peak * 0.93).toFixed(2)}`);
      }
      const m10Old = m10;
      if (price > trailPx && trailPx > stopPx) {
        gen.push({
          name: `${p.标的}[持仓-移动止损]`, tencent: ten, op: '<=', price: trailPx,
          msg: `🟢移动止损${trailPx}(取三者最高: ${parts.join(' / ')}) - 浮盈${(pl * 100).toFixed(1)}%,跌破即离场保利润。口径与回测baseline一致(研究L)。触发=ping Claude`,
          enabled: true, posauto: true, sell: true
        });
        log.push(`${p.标的} +移动止损=${trailPx} [${parts.join(' ')}] (较原止损${stopPx}上移${(trailPx - stopPx).toFixed(2)})`);
        stopUpdates.push({ name: p.标的, stop: trailPx, basis: parts.join(' ') });
      } else {
        const why = price <= trailPx ? `价${price}未站上移动止损位${trailPx}` : `移动止损位${trailPx}未超过现止损${stopPx}(只升不降)`;
        log.push(`${p.标的} 未布移动止损(${why}; MA10=${m10Old})`);
      }
    } else {
      log.push(`${p.标的} K线拉取失败→仅布硬止损(已兜底)`);
    }
  }

  obj.alerts = [...keep, ...gen];
  obj._posarmed = bj();

  // 2026-08-13 修 bug：移动止损此前只写进 alerts.json，没回写 positions.json。
  // 一旦某天 K线拉取失败(本环境常见)，重新生成时读的是 positions.json 里的旧止损，
  // 已经爬上去的移动止损就**悄悄退回**，违反"只升不降"铁律，在趋势票上会持续漏掉已锁的利润。
  // 实例：京东方 08-12 移动止损升到 5.83，08-13 K线失败后退回 5.76。
  // 修法：算出更高的移动止损时同步写回 positions.json，让它成为新的持久化止损基线。
  if (stopUpdates.length && !DRY) {
    const posRaw = JSON.parse(fs.readFileSync(posFile, 'utf8'));
    for (const u of stopUpdates) {
      const t = (posRaw.持仓 || []).find(x => x.标的 === u.name);
      if (t && (!(t.止损价 > 0) || u.stop > t.止损价)) {
        t._止损备注 = `${(t._止损备注 || '').replace(/\s*\|\s*移动止损自动上移.*$/, '')} | 移动止损自动上移 ${t.止损价}→${u.stop} (${u.basis}, ${bj()})`.trim();
        t.止损价 = u.stop;
      }
    }
    fs.writeFileSync(posFile, JSON.stringify(posRaw, null, 2) + '\n', 'utf8');
    console.log(`↑ 已回写 positions.json 止损价: ${stopUpdates.map(u => `${u.name}→${u.stop}`).join(', ')}`);
  }

  console.log(`=== 持仓布防 ${obj._posarmed} ===`);
  console.log(`持仓 ${pos.length} 只 | 保留旧条目 ${keep.length} | 生成 posauto ${gen.length}`);
  gen.forEach(a => console.log(`  ★ ${a.name} ${a.op}${a.price}${a.sell ? ' [sell]' : ''}`));
  if (log.length) console.log('明细: ' + log.join(' | '));

  if (DRY) { console.log('\n[--dry] 未写文件。'); return; }
  fs.writeFileSync(alertsFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  console.log(`\n✅ 已写入 ${alertsFile}（共 ${obj.alerts.length} 条触发器）`);
})();
