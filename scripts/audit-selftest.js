#!/usr/bin/env node
/**
 * audit.js 文档检查器的自测 (2026-08-14)
 *
 * 为什么需要它：检查器首版曾**漏掉两处真问题**（risk-management 第216/254行的
 * "移动止损跟MA10"），而它当时对全部文档报"✅ 无残留"。
 * **一个只会说"通过"的检查器比没有检查器更危险**——它给出虚假的安全感。
 * 故把已知漏网案例固化成回归用例，改检查器后必须跑这个。
 *
 * 两个已修复的漏洞：
 *   ① ok 判定看整行任意位置 → 216行被同行无关的"证伪"(说的是保本位)豁免
 *   ② re 距离 .{0,6} 太短   → 254行"移动止损继续按第五节跟 MA10"隔9字，压根没匹配
 *
 * Usage: node scripts/audit-selftest.js
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'audit.js'), 'utf8');

// 从 audit.js 抽出被测部件（保持单一真相源，避免测试与实现各写一份）
const depSrc = src.slice(src.indexOf('const DEPRECATED = ['), src.indexOf('// 关键词附近是否有否定'));
const fnSrc = src.slice(src.indexOf('function annotatedNear'), src.indexOf('const HIST'));
const mod = new Function(depSrc + fnSrc + '; return { DEPRECATED, annotatedNear };')();
const { DEPRECATED, annotatedNear } = mod;

const CASES = [
  // ---- MA10：两个真实漏网案例 ----
  ['MA10', '漏网案例1(216行原文·同行有无关的"证伪")',
    '   - ~~加仓后**整体止损必须≥保本位**~~ **🔴 已废止（研究K证伪）**。改为：**加仓后维持原止损，移动止损照常跟 MA10 爬**；', true],
  ['MA10', '漏网案例2(254行原文·距离9字)',
    '加仓**不改动**已有止损位，移动止损继续按第五节跟 MA10/前低爬。', true],
  ['MA10', '正确标注·剔除', '移动止损口径：max(原止损,保本位,峰值×0.93)，MA10 已被 v2.12 剔除', false],
  ['MA10', '正确标注·严禁', '🔴 MA10 严禁进入移动止损', false],
  ['MA10', '无关文本', '现价贴近 MA10(±2%) 才算回踩买点', false],
  // ---- 盈亏比 ----
  ['盈亏比', '未标注的硬闸门', '买入必须满足 盈亏比 ≥ 2，否则不买', true],
  ['盈亏比', '正确标注·废止', '~~盈亏比 ≥ 2~~ v2.13 已废止（研究Q/R/Q-2证伪）', false],
  // ---- 冲高回落阈值 ----
  ['冲高回落', '未标注的旧阈值', '冲高回落：日内涨 >5% 后从高点回落 >2%，减半锁利', true],
  ['冲高回落', '正确标注', '日内涨 >5% 后回落（原5%，v2.11 已改为 7%）', false],
];

let pass = 0, fail = 0;
console.log('=== audit.js 文档检查器 自测 ===\n');
for (const [key, name, text, shouldFlag] of CASES) {
  const dp = DEPRECATED.find(d => d.name.includes(key));
  if (!dp) { console.log(`  ⚠️ 找不到规则「${key}」，跳过`); continue; }
  const flagged = dp.re.test(text) && !annotatedNear(text, dp);
  const ok = flagged === shouldFlag;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} [${key}] ${name} → ${flagged ? '报错' : '放过'}（期望${shouldFlag ? '报错' : '放过'}）`);
}
console.log(`\n${fail === 0 ? '✅' : '🔴'} 回归 ${pass}/${pass + fail} 通过`);
if (fail) console.log('⚠️ 检查器有回归！改 DEPRECATED 规则后必须让本测试全绿再提交。');
process.exit(fail ? 1 : 0);
