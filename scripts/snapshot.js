#!/usr/bin/env node
/**
 * 定时资金流快照 (snapshot.js) —— 为「盘中资金流量」研究积累**均匀采样**的数据。
 *
 * 立此脚本的原因（2026-08-20）：
 * 用户提出「早盘主力+2亿、下午变+1亿，累计仍为正，这种怎么算」——指出闸门只看**存量**
 * (main>0)、不看**流量**(在变好还是变坏)。想回测这个问题时发现数据不够用：
 *   · cache/intraday 只在 confirm.js 被调用时写入，而 confirm.js 只在**弹窗触发**时跑
 *   · 结果是**事件驱动采样**：11个交易日只有31个股票日，其中12个是恒瑞(它天天触发)，
 *     且几乎全是资金流出日 —— 「主力仍为正但衰减」的样本数为 **0**
 *   · 这种偏斜样本无法支撑任何统计结论，只能拍脑袋定阈值（=重蹈 v2.8 保本位止损的覆辙）
 *
 * 本脚本改为**均匀采样**：对 alerts.json 里所有在盯的票，在固定时点各拍一次快照。
 * 只拉 flow 单接口（1次/票），不做完整 confirm，把开销压到最低。
 *
 * 用法:
 *   node scripts/snapshot.js            # 拍一次（供 check-alerts.ps1 在固定时点调用）
 *   node scripts/snapshot.js --dry      # 只打印不写文件
 *
 * 输出：追加到 cache/intraday/<日期>.jsonl，与 confirm.js 同格式（多一个 src:'snap' 标记，
 * 便于将来回测时区分"定时采样"与"触发时采样"，避免把两种采样混在一起算）。
 */
const fs = require('fs');
const path = require('path');
const DRY = process.argv.includes('--dry');
const root = path.join(__dirname, '..');
const CACHE_DIR = path.join(root, 'cache', 'intraday');

function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function todayStr() { return bjNow().toISOString().slice(0, 10); }
function hhmm() { return bjNow().toISOString().slice(11, 16); }

// 交易时段判断（非交易时段直接退出，避免污染样本）
function inSession() {
  const d = bjNow();
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  return (hm >= 930 && hm <= 1130) || (hm >= 1300 && hm <= 1500);
}

function tencentToSecid(t) {
  if (/^sz(\d+)$/.test(t)) return '0.' + RegExp.$1;
  if (/^sh(\d+)$/.test(t)) return '1.' + RegExp.$1;
  return null;
}

async function getFlow(secid) {
  const u = `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=1&klt=101`;
  // 2026-08-20 首跑实测成功率仅 10/19（东财接口在本环境不稳），数据有缺口就失去均匀采样的意义。
  // 重试 3→6 次、退避拉长到 500ms 起，单票最坏耗时约 10s；19只全失败也只 3 分钟，仍在 1 分钟轮询的容忍外——
  // 但快照每天只跑 4 次，慢一点无所谓，**完整性比速度重要**。
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Connection': 'close' } }).then(x => x.json());
      const ks = r && r.data && r.data.klines;
      if (ks && ks.length) {
        const p = ks[ks.length - 1].split(',');
        const main = +p[1] / 1e8, small = +p[2] / 1e8, medium = +p[3] / 1e8, large = +p[4] / 1e8, superL = +p[5] / 1e8;
        // 恒等式校验：主力 = 超大单 + 大单（不通过则标记，不静默采信）
        const idOk = Math.abs(main - (superL + large)) < 0.01;
        return { name: r.data.name, main, superL, largeL: large, medium, small, idOk };
      }
    } catch (e) { /* retry */ }
    await new Promise(s => setTimeout(s, 500 * (i + 1)));
  }
  return null;
}

(async () => {
  if (!inSession() && !DRY) { console.log(`[snapshot] ${hhmm()} 非交易时段，跳过`); return; }

  let alerts = [];
  try { alerts = (JSON.parse(fs.readFileSync(path.join(root, 'alerts.json'), 'utf8')).alerts || []).filter(a => a.enabled !== false); }
  catch (e) { console.log('[snapshot] 读 alerts.json 失败:', e.message); return; }

  // 去重：同一只票可能挂多条触发线（止损/加仓/突破…），只拍一次
  const seen = new Set(), targets = [];
  for (const a of alerts) {
    if (!a.tencent || seen.has(a.tencent)) continue;
    const secid = tencentToSecid(a.tencent);
    if (!secid) continue;
    seen.add(a.tencent);
    targets.push({ secid, tencent: a.tencent, label: a.name });
  }

  const time = hhmm();
  const lines = [];
  let ok = 0, fail = 0, idBad = 0;
  for (const t of targets) {
    const f = await getFlow(t.secid);
    if (!f) { fail++; continue; }
    if (!f.idOk) idBad++;
    ok++;
    lines.push(JSON.stringify({
      secid: t.secid, name: f.name || t.label, time,
      main: +f.main.toFixed(4), superL: +f.superL.toFixed(4), largeL: +f.largeL.toFixed(4),
      idOk: f.idOk, src: 'snap',      // ← 与 confirm.js 触发时写入的快照区分开
    }));
    await new Promise(s => setTimeout(s, 250));
  }

  console.log(`[snapshot] ${todayStr()} ${time} | 目标${targets.length}只 成功${ok} 失败${fail}${idBad ? ' 恒等式异常' + idBad : ''}`);
  if (DRY) { lines.slice(0, 5).forEach(l => console.log('  ' + l)); console.log('[--dry] 未写文件'); return; }
  if (!lines.length) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.appendFileSync(path.join(CACHE_DIR, `${todayStr()}.jsonl`), lines.join('\n') + '\n');
    console.log(`  ✅ 已追加 ${lines.length} 条 → cache/intraday/${todayStr()}.jsonl`);
  } catch (e) { console.log('  写入失败:', e.message); }
})();
