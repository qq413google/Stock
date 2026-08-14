#!/usr/bin/env node
/**
 * 操作后自查 (audit.js) —— 每笔买卖/止损后必跑，AGENTS.md「强制自查」的自动化部分。
 *
 * 立此脚本的原因(2026-08-14)：研究K/M/N/O/P 五次回测全部由用户推动，Claude 零主动。
 * 京东方止损bug(实盘移动止损含MA10、回测baseline不含)在实盘跑了数日无人察觉，
 * 直到用户追问"才亏1个多点合理吗"才暴露——统计后果 -21.6万/回撤115%。
 * **机械可查的部分不该依赖任何人(或AI)记得去查。**
 *
 * 检查项：
 *   1. 止损一致性  positions.json 的止损价 ↔ alerts.json 实际布防的最高卖出线
 *   2. 参数漂移    实盘移动止损口径 ↔ 回测baseline(浮盈≥5%→max(成本,峰值×0.93)，不含MA10)
 *   3. 布防完整性  每只持仓是否都有 sell 类触发线兜底
 *   4. 账目自洽    现金+持仓市值 ≈ 总资金(允许浮盈亏差额)
 *   5. 未验证规则清单  列出当前生效但无回测背书的条款，提醒主动提议回测
 *
 * Usage: node scripts/audit.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const rd = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const issues = [], notes = [];
const pos = rd('positions.json');
const alerts = rd('alerts.json').alerts || [];
const holdings = pos.持仓 || [];

console.log('=== 操作后自查 audit.js ===\n');

// ---------- 1. 止损一致性 ----------
console.log('【1】止损一致性 (positions.json ↔ alerts.json)');
for (const h of holdings) {
  const ten = (String(h.代码).split('.')[0] === '0' ? 'sz' : 'sh') + String(h.代码).split('.')[1];
  const sells = alerts.filter(a => a.tencent === ten && a.sell && a.op === '<=' && a.enabled !== false);
  if (!sells.length) {
    issues.push(`${h.标的} 无任何 sell 类止损触发线 —— 持仓裸奔！`);
    console.log(`  🔴 ${h.标的}: 无止损触发线`);
    continue;
  }
  const effective = Math.max(...sells.map(a => +a.price));   // 最高的那条先触发
  const planned = +h.止损价;
  const mark = Math.abs(effective - planned) < 0.005 ? '✅' : '⚠️';
  if (mark === '⚠️') {
    issues.push(`${h.标的} 止损不一致: positions=${planned} vs alerts实际生效=${effective}`);
  }
  console.log(`  ${mark} ${h.标的}: positions=${planned} | alerts生效=${effective} | 共${sells.length}条sell线`);
  // 与建仓计划止损对比(从备注里找不到就跳过)
  const memo = (h._备注 || '') + (h._止损备注 || '');
  const m = memo.match(/止损\s*([0-9]+\.[0-9]+)/);
  if (m) {
    const orig = +m[1];
    if (effective > orig * 1.005) {
      notes.push(`${h.标的} 当前止损${effective}已高于建仓计划止损${orig}(收紧${((effective / orig - 1) * 100).toFixed(1)}%) —— 确认是移动止损上移(正常)而非参数漂移(bug)`);
    }
  }
}

// ---------- 2. 参数漂移: 移动止损口径 ----------
console.log('\n【2】参数漂移: 实盘移动止损口径 vs 回测baseline');
const armSrc = fs.readFileSync(path.join(root, 'scripts', 'arm-positions.js'), 'utf8');
const trailBlock = armSrc.slice(armSrc.indexOf('const parts = []'), armSrc.indexOf('if (everProfit && price > trailPx'));
const hasM10InTrail = /trailPx\s*=\s*Math\.max\([^)]*m10/.test(trailBlock) || /trailPx\s*=\s*m10/.test(trailBlock);
if (hasM10InTrail) {
  issues.push('移动止损公式含 MA10 —— 研究P已证伪(总盈亏157,339→27,188甚至-59,328/回撤115%)');
  console.log('  🔴 检测到 MA10 参与移动止损计算 —— 与回测baseline不一致');
} else {
  console.log('  ✅ 移动止损 = max(保本位, 峰值×0.93)，不含MA10，与研究P结论一致');
}
const hasEverProfitGate = /if\s*\(everProfit\)/.test(trailBlock);
console.log(`  ${hasEverProfitGate ? '✅' : '🔴'} 浮盈≥5%门槛${hasEverProfitGate ? '存在' : '缺失(会在浮亏时收紧止损)'}`);
if (!hasEverProfitGate) issues.push('移动止损缺少 everProfit 门槛，浮亏时会错误收紧止损');

// ---------- 3. 布防完整性 ----------
console.log('\n【3】布防完整性');
const posarmed = rd('alerts.json')._posarmed || '(无)';
console.log(`  最近持仓布防时间: ${posarmed}`);
for (const h of holdings) {
  const ten = (String(h.代码).split('.')[0] === '0' ? 'sz' : 'sh') + String(h.代码).split('.')[1];
  const kinds = alerts.filter(a => a.tencent === ten && a.posauto).map(a => a.name.replace(/^.*\[/, '[').replace(/\]$/, ']'));
  console.log(`  ${h.标的}: ${kinds.length ? kinds.join(' ') : '🔴 无 posauto 触发线'}`);
  if (h.股数 >= 200 && !kinds.some(k => k.includes('冲高回落'))) {
    notes.push(`${h.标的} ${h.股数}股(≥200可减半)但无冲高回落止盈线`);
  }
}

// ---------- 4. 账目自洽 ----------
console.log('\n【4】账目自洽');
const cash = +pos.account.可用现金, total = +pos.account.总资金;
const costSum = holdings.reduce((a, h) => a + h.成本价 * h.股数, 0);
const diff = cash + costSum - total;
console.log(`  现金 ${cash.toFixed(2)} + 持仓成本 ${costSum.toFixed(2)} = ${(cash + costSum).toFixed(2)} | 总资金基准 ${total.toFixed(2)} | 差额 ${diff.toFixed(2)}`);
if (Math.abs(diff) > 50) {
  issues.push(`账目差额 ${diff.toFixed(2)} 元 (>50) —— 检查是否漏记手续费/成交价待确认`);
  console.log('  ⚠️ 差额偏大，检查漏记项');
} else {
  console.log('  ✅ 账目自洽(差额在手续费范围内)');
}

// ---------- 5. 未验证规则清单 ----------
console.log('\n【5】当前生效但**无回测背书**的规则 —— 用到时必须标注，并主动提议回测');
const UNVERIFIED = [
  ['加仓门槛 浮盈≥5%', '研究M测的是"阈值高低"，5%这个数本身仍是沿用约定'],
  ['加仓盈亏比≥2闸门 (v2.10)', '🔴v2.13降级为参考——建立在已被证伪的盈亏比概念上，加仓场景未单独回测'],
  ['目标位取法(前高/整数关/MA60)', '主观估算，无统一验证'],
  ['开盘30分钟噪声窗 (v2.6)', '经验总结；无分钟级历史数据可回测'],
  ['单票加仓限1次 (v2.8)', '研究O验证了"不许恢复"，但"限1次"本身未单独测'],
  ['高相关赛道合并算敞口 (v2.7#7)', '逻辑推演'],
  ['当日涨>3%禁买 (v2.14)', '✅研究S已测：非稳定edge而是回撤旋钮(两半段结论不一致)，按用户风险偏好选定；实际只拦超跌反包'],
];
UNVERIFIED.forEach(([r, why]) => console.log(`  ⚪ ${r} —— ${why}`));

// ---------- 6. 文档一致性 ----------
// 2026-08-14 加：全文档审查一次扫出18处过时/矛盾（"移动止损跟MA10"在3文件5处残留、
// 用户画像写着空仓、版本历史缺v2.11~v2.14）。根因是结构性的——改规则时只改"生效的那一处"，
// 漏掉散落各处的摘要/速查表/示例。机械可查的部分不该靠人记得全库搜一遍。
console.log('\n【6】文档一致性 (已废止概念是否还在当前表述里)');
const DOCS = ['AGENTS.md', 'SKILL.md', '策略共识与验证计划.md', 'references/risk-management.md'];
// okIfNear: 同一行里出现这些词说明已正确标注为废止/历史，不算问题
const DEPRECATED = [
  { name: '盈亏比≥2 门槛 (v2.13废止)', re: /盈亏比\s*[≥>]=?\s*2(?!\d)/, ok: /废止|证伪|降级|v2\.13|作废|不再|原文/ },
  { name: '移动止损含MA10 (v2.12剔除)', re: /移动止损.{0,6}MA10|MA10.{0,4}移动止损/, ok: /剔除|不含|严禁|已从|证伪|v2\.12|无MA10|推翻|作废/ },
  { name: '冲高回落5%阈值 (v2.11改7%)', re: /日内涨\s*[>＞]\s*5%|涨\s*[>＞]\s*5%\s*后从高点/, ok: /v2\.11|原5%|改为|证伪|7%/ },
  { name: '当日涨>5%禁买 (v2.14改3%)', re: /当日\*{0,2}涨幅?\s*[>＞]\s*5%/, ok: /v2\.14|原5%|原为|加仓|豁免|历史|改为/ },
];
const HIST = /^\s*[-*]\s*\**v\d|^\s*[-*]\s*\**20\d\d-\d\d-\d\d/;   // 版本历史条目：保持原貌，不算问题
let docIssues = 0;
for (const d of DOCS) {
  let txt;
  try { txt = fs.readFileSync(path.join(root, d), 'utf8'); } catch { continue; }
  const inHistFrom = txt.indexOf('## 版本历史');
  const lines = txt.split('\n');
  // 用累计偏移定位版本历史起点，避免每行重算(原实现每行都 slice+join，O(n^2))
  let off = 0;
  lines.forEach((line, i) => {
    const myOff = off; off += line.length + 1;
    if (inHistFrom >= 0 && myOff > inHistFrom) return;   // 版本历史整节跳过
    if (HIST.test(line)) return;
    // 2026-08-14 修：首版只看单行，把"说明写在下一行"的正确标注误报为问题
    // (risk-mgmt:184「加仓盈亏比≥2」的"降级为参考"写在185行)。改为看 ±1 行的上下文窗口。
    const ctx = [lines[i - 1] || '', line, lines[i + 1] || ''].join(' ');
    for (const dp of DEPRECATED) {
      if (dp.re.test(line) && !dp.ok.test(ctx)) {
        issues.push(`${d}:${i + 1} 仍在用已废止概念「${dp.name}」且未标注`);
        console.log(`  🔴 ${d}:${i + 1} ${dp.name}`);
        docIssues++;
      }
    }
  });
}
// 版本号一致性：规则文件最新版 vs 各处速查表引用
const rm = fs.readFileSync(path.join(root, 'references', 'risk-management.md'), 'utf8');
const latest = (rm.match(/^- \*\*v(\d+\.\d+\w*)/m) || [])[1];
if (latest) {
  const ag = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const cited = [...ag.matchAll(/速查 · v([\d.]+)|唯一规则源，当前 v([\d.]+)/g)].map(m => m[1] || m[2]);
  const bad = cited.filter(v => v !== latest.replace(/[a-z]$/, ''));
  if (bad.length) { issues.push(`AGENTS 速查表版本号 ${bad.join('/')} 落后于规则文件最新 v${latest}`); console.log(`  🔴 版本号落后: AGENTS引用v${bad.join('/')} vs 规则最新v${latest}`); docIssues++; }
  else console.log(`  ✅ 版本号一致 (规则最新 v${latest})`);
}
// 自选池只数：watchlist.json 实际 vs 文档描述
const wlN = JSON.parse(fs.readFileSync(path.join(root, 'watchlist.json'), 'utf8')).stocks.length;
const agTxt = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const claimed = [...agTxt.matchAll(/自选股池[^\n]{0,6}[（(](\d+)\s*只/g)].map(m => +m[1]);
const wrong = claimed.filter(c => c !== wlN);
if (wrong.length) { issues.push(`AGENTS 写自选池 ${wrong.join('/')} 只，实际 ${wlN} 只`); console.log(`  🔴 自选池只数: 文档${wrong.join('/')} vs 实际${wlN}`); docIssues++; }
else console.log(`  ✅ 自选池只数一致 (${wlN}只)`);
// 账户状态是否被写死进文档（静态快照必然过时）
if (/当前状态[：:]\s*(空仓|持仓)/.test(agTxt) && !/不写死|现读/.test(agTxt.match(/当前状态[：:][^\n]*/)[0])) {
  issues.push('AGENTS 用户画像写死了账户状态 —— 静态快照必然过时，应改为"现读 positions.json"');
  console.log('  🔴 用户画像写死账户状态'); docIssues++;
}
if (!docIssues) console.log('  ✅ 未发现已废止概念的残留');

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(50));
if (issues.length) {
  console.log(`🔴 发现 ${issues.length} 个问题，必须处理：`);
  issues.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
} else {
  console.log('✅ 机械检查全部通过');
}
if (notes.length) {
  console.log(`\n🟡 需人工确认 ${notes.length} 项：`);
  notes.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
console.log('\n⚠️ 机械检查通过 ≠ 决策正确。仍须人工回答 AGENTS「强制自查」四问：');
console.log('   ①参数漂移 ②依据强度(验证过还是推演) ③实盘vs回测口径 ④是process对还是运气好');
process.exit(issues.length ? 1 : 0);
