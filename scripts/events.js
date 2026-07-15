#!/usr/bin/env node
/**
 * 事件日历(除权除息/解禁/财报) — 手动维护 ../events.json
 * Usage: node events.js
 * 按日期升序列出全部事件（数据手动维护，故不按系统时钟过滤，避免环境时钟误差）。
 */
const fs = require('fs');
const path = require('path');
const e = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'events.json'), 'utf8'));
const all = [];
for (const [type, arr] of Object.entries(e)) {
  if (Array.isArray(arr)) arr.forEach(x => all.push({ ...x, type }));
}
all.sort((a, b) => String(a.日期).localeCompare(String(b.日期)));
console.log('=== 事件日历 (除权除息/解禁/财报) ===');
if (!all.length) { console.log('无（在 events.json 中维护）'); }
else all.forEach(x => console.log(`${x.日期} [${x.type}] ${x.标的}(${x.代码 || ''}) ${x.类型 || ''}`));
