#!/usr/bin/env node
/**
 * 交易复盘统计
 * Usage: node stats.js
 * 读取 ../trades.json，算胜率/盈亏比/累计盈亏/纪律执行率。
 */
const fs = require('fs');
const path = require('path');
const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'trades.json'), 'utf8'));
if (!t.length) { console.log('暂无交易记录'); process.exit(0); }

const wins = t.filter(x => x.盈亏 > 0), losses = t.filter(x => x.盈亏 < 0);
const totalPL = t.reduce((s, x) => s + x.盈亏, 0);
const avgWin = wins.length ? wins.reduce((s, x) => s + x.盈亏, 0) / wins.length : 0;
const avgLoss = losses.length ? Math.abs(losses.reduce((s, x) => s + x.盈亏, 0) / losses.length) : 0;
const rr = avgLoss ? avgWin / avgLoss : 0;
const disc = t.filter(x => x.守纪律).length;

console.log('=== 交易复盘统计 ===');
console.log(`总交易:${t.length} 胜:${wins.length} 负:${losses.length} 胜率:${(wins.length / t.length * 100).toFixed(0)}%`);
console.log(`平均盈利:${avgWin.toFixed(0)}元 平均亏损:${avgLoss.toFixed(0)}元 盈亏比:${rr.toFixed(2)}`);
console.log(`累计盈亏:${totalPL.toFixed(0)}元 纪律执行率:${(disc / t.length * 100).toFixed(0)}%`);
if (wins.length / t.length < 0.4 && rr < 2 && t.length >= 5) console.log('⚠️ 胜率<40%且盈亏比<2：按规则应降频/调整策略');
console.log('--- 明细 ---');
t.forEach(x => console.log(`${x.买入日}~${x.卖出日 || '持仓'} ${x.标的} ${x.盈亏 >= 0 ? '+' : ''}${x.盈亏}元 ${x.守纪律 ? '守纪律✅' : '违纪❌'} ${x.教训 || x.买点类型 || ''}`));
