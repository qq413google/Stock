# SETUP · 从零部署这套 A 股盯盘系统

> 读者：**接手这个项目的人或 AI**。照本文做完，你会得到一套每分钟自动盯盘、碰线弹窗+响铃、
> 且**不消耗任何 AI token** 的实盘辅助系统。
> 决策规则和分析工作流不在这里 —— 那些在 [AGENTS.md](AGENTS.md)（**AI 进来必须先读它**）。

---

## 一、这是什么（30 秒版）

一个 **A 股散户实盘辅助系统**，两层结构：

```
┌─ 零 token 层（机器干活，7×24 不花钱）──────────────┐
│  Windows 定时任务 每1分钟 → check-alerts.ps1        │
│    读 alerts.json 的触发线 → 拉腾讯行情 → 碰线弹窗+响铃 │
│    每日 09:30/13:30 自动重算触发线(arm-alerts +      │
│    arm-positions)                                   │
└──────────────┬─────────────────────────────────────┘
               │ 弹窗了，用户拿来问
               ▼
┌─ AI 层（只在被问时介入，才花 token）────────────────┐
│  现拉数据 → 过风控闸门 → 给带止损/盈亏比的结论        │
│  规则源: references/risk-management.md (唯一权威)    │
└─────────────────────────────────────────────────────┘
```

**设计意图**：盯盘是机器的活（便宜、不会累、不会情绪化），判断才是 AI 的活。
所以弹窗只负责"叫你来看"，**永远不替你扣扳机**。

---

## 二、系统要求

| 项 | 要求 | 检查命令 |
|---|---|---|
| 操作系统 | **Windows**（依赖任务计划程序 + MessageBox 弹窗） | — |
| Node.js | ≥ 18（用到内置 `fetch`，本机 v24.15.0） | `node --version` |
| PowerShell | 5.1（Windows 自带即可） | `$PSVersionTable.PSVersion` |
| 网络 | 能访问 `push2.eastmoney.com` / `push2his.eastmoney.com` / `qt.gtimg.cn` | 见下方验证 |
| 依赖包 | **零**。所有脚本只用 Node 内置模块，不需要 `npm install` | — |

> 非 Windows 环境：数据脚本（`scripts/*.js`）全部可用，但**盯盘弹窗层跑不了**
> （需替换成 cron + 你自己的通知方式，如 ntfy/Telegram/邮件）。

---

## 三、部署步骤

### 1. 放置文件

把整个目录放到任意路径，例如 `D:\AI\workspace\stock`。下文用 `<ROOT>` 指代它。

### 2. 路径（已自动处理，无需手改）

`tasks/run-hidden.vbs` 会**从自身位置推导** `check-alerts.ps1` 的路径，移动或复制整个
目录都不会失效。

> 这个 vbs 的作用：以**完全隐藏**的窗口模式启动 PowerShell（`Run(..., 0, False)` 的那个 `0`），
> 否则每分钟会闪一次黑色控制台窗口。弹窗仍能正常显示，因为它跑在用户会话里。
>
> ⚠️ 历史坑（2026-08-11 修复）：此处曾硬编码 `D:\AI\workspace\stock\...`。换机器时它会
> **静默失效**——定时任务照常报成功，但实际什么都没检查，止损也不会响。若你接手的是旧版本，
> 务必确认这里已改成自推导。

### 3. 验证数据链路（先确认能拉到数据，再建任务）

```bash
cd <ROOT>
node scripts/quote.js 0.300347     # 实时报价，应输出 "泰格医药(300347): 现价=..."
node scripts/market.js             # 三大指数 + 市场分级
node scripts/flow.js 0.300347      # 资金流，必须显示 "恒等式✅"
```

三条都有输出才继续。**东财接口时常抽风返回 HTML 或断连**，脚本内置了重试；
若连续多次失败，先排查网络/代理，别急着建任务。

### 4. 初始化数据文件

| 文件 | 作用 | 首次部署怎么填 |
|---|---|---|
| `watchlist.json` | 自选池（决定盯哪些票） | 按现有格式改成你的票；`secid` 深市 `0.xxxxxx` 沪市 `1.xxxxxx`，`tencent` 深 `szxxxxxx` 沪 `shxxxxxx` |
| `positions.json` | 当前持仓 + 现金 | 空仓就把 `持仓: []`，改 `account` 里的总资金/可用现金 |
| `trades.json` | 已平仓记录（战绩统计用） | 全新账户填 `[]` |
| `events.json` | 事件日历（财报/解禁） | 可留空 |
| `alerts.json` | **不用手填**，下一步自动生成 | — |

### 5. 生成第一批触发线

```bash
node scripts/arm-alerts.js      # 从 watchlist 挑票 → 买入观察线
node scripts/arm-positions.js   # 从 positions 生成 → 止损/移动止损/冲高回落止盈/加仓观察
```

用 `--dry` 可以只预览不写文件。

### 6. 创建定时任务（**需要管理员 PowerShell**）

```powershell
$root   = "D:\AI\workspace\stock"        # ← 改成你的 <ROOT>
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "$root\tasks\run-hidden.vbs"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "StockAlerts" -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force
```

**关键参数解释（别乱改）**：
- `LogonType Interactive` —— 必须在用户会话里跑，否则**弹窗看不见**（服务会话的窗口在另一个桌面）
- `MultipleInstances IgnoreNew` —— 上一轮没跑完就跳过本轮，防止重叠堆积
- `RepetitionInterval 1分钟` —— 盘中反应速度；改这个需管理员权限（见运维章节）
- 无 `Duration` —— 永久重复

### 7. 验证部署

```powershell
Get-ScheduledTaskInfo -TaskName "StockAlerts"     # LastTaskResult 应为 0
(Get-ScheduledTask -TaskName "StockAlerts").Triggers[0].Repetition.Interval   # 应为 PT1M
powershell -ExecutionPolicy Bypass -File "<ROOT>\tasks\check-alerts.ps1" -Test # dry-run
```

`-Test` 会打印每条触发线的当前状态（armed / fired）而**不弹窗、不写状态、不刷新布防**，
是最安全的排查手段。

---

## 四、日常运维

```powershell
# 看盯盘是否在跑
Get-ScheduledTaskInfo -TaskName "StockAlerts"       # LastRunTime / LastTaskResult(0=成功) / NextRunTime

# 看今天弹过什么
Get-Content "<ROOT>\tasks\alerts.log" -Tail 30

# 看当前触发线状态（不弹窗）
powershell -ExecutionPolicy Bypass -File "<ROOT>\tasks\check-alerts.ps1" -Test

# 改轮询频率（管理员）
$t = Get-ScheduledTask -TaskName "StockAlerts"
$t.Triggers[0].Repetition.Interval = "PT1M"    # PT1M=1分钟 PT3M=3分钟
Set-ScheduledTask -InputObject $t

# 临时停 / 恢复
Disable-ScheduledTask -TaskName "StockAlerts"
Enable-ScheduledTask  -TaskName "StockAlerts"
```

**买卖成交后必做**（否则风控失效）：
```bash
# 1) 手工改 positions.json（持仓/现金），平仓的补一条进 trades.json
# 2) 重新布防 + 校验
node scripts/arm-positions.js
node scripts/positions.js
# 3) 必做：事后自查(止损一致性/参数漂移/账目自洽/文档一致性)
node scripts/audit.js
```

---

## 五、盯盘系统内部机制（排查时需要知道）

| 机制 | 说明 |
|---|---|
| **边沿触发** | 穿越触发线才弹，贴着线不会每分钟刷屏；价格反向脱离 0.5%（`$ReArmBuffer`）后重新武装 |
| **状态文件** | `tasks/alerts-state.json` 记录每条线的 armed/passed，**按"代码\|触发器名\|阈值"三段分键**（2026-08-14起）：同一只票的止损/加仓互不干扰，且**触发线一变就自动重新评估 armed**——此前只按前两段分键，13:30 重布防改了触发线后仍沿用旧 armed，导致德赛西威误报"反弹收复"；跨日自动清空 |
| **每日重布防** | 首次跑到 ≥09:30 和 ≥13:30 时，各自动跑一次 `arm-alerts.js` + `arm-positions.js` |
| **崩盘门** | 三大指数均值 ≤ -1.5% 时静音**买入类**提醒（暴跌日全是飞刀）；**`sell:true` 的止损/止盈照弹** |
| **开盘噪声窗** | 09:30–10:00 的弹窗自动加 `LOOK ONLY` 横幅（开盘插针不算数，见风控 v2.6） |
| **reclaim guard** | `op:>` 的"反弹收复"类触发器要求**昨收≤线 或 当日最低≤线**才算数——防止"从上方跌来还没破线"被误判成"从下方收复"（2026-08-14 德赛西威实例）|
| **冲高回落止盈** | `spikeFade:true`，盘中实时算 `日内涨幅>7%`(v2.11) 且 `从高点回落>2%`；仅≥200股持仓才布 |
| **分级音效** | 卖出类=系统警报+1175Hz 三连×2；买入类=柔和双音。声音在阻塞式弹窗**之前**播放 |
| **零 token** | 整条链路只有 PowerShell + Node，不调用任何 AI；AI 只在你拿弹窗去问时才介入 |

---

## 六、常见问题

**Q：弹窗不出现，但日志有记录？**
定时任务的 `LogonType` 不是 `Interactive`（跑在服务会话，窗口在别的桌面）。按第 6 步重建。

**Q：每分钟闪黑窗口？**
任务的 Action 没走 `run-hidden.vbs`，而是直接调了 `powershell.exe`。

**Q：`LastTaskResult` 非 0？**
先手动跑一次看报错：`powershell -ExecutionPolicy Bypass -File "<ROOT>\tasks\check-alerts.ps1" -Test`。
最常见是 `positions.json` / `alerts.json` **JSON 语法坏了**（中文引号、缺逗号）。用
`node -e "JSON.parse(require('fs').readFileSync('positions.json','utf8'))"` 逐个验。

**Q：脚本报 `fetch failed` / 返回 HTML？**
东财接口抽风，脚本已内置 3~5 次重试。持续失败就换网络环境；`positions.js` 会明确报
"取价失败→本票风控未校验"而不是静默跳过。

**Q：改了 `check-alerts.ps1` 后中文乱码？**
该文件**必须保持纯 ASCII**（PowerShell 5.1 读无 BOM 的非 ASCII .ps1 会乱码）。
中文只能出现在 `alerts.json` 的数据里和 `confirm.js` 的输出里（脚本用 UTF8 捕获它们）。

**Q：想换成非 Windows / 手机推送？**
`scripts/*.js` 全部跨平台可用。只需重写 `tasks/check-alerts.ps1` 的通知部分
（`Play-AlertSound` + `MessageBox::Show`）为 ntfy / Telegram Bot / 邮件，其余逻辑可整体照搬。

---

## 七、文件地图

```
<ROOT>
├── AGENTS.md              ← ⭐ AI 进来第一个读（角色/铁律/任务速查表）
├── SETUP.md               ← 本文（部署运维）
├── SKILL.md               ← 分析工作流与输出模板
├── references/
│   └── risk-management.md ← ⭐ 唯一规则源（其它地方的规则摘要都可能滞后）
├── 策略共识与验证计划.md    ← 核心认知 + 已证伪的信号清单（别重复踩坑）
├── scripts/               ← 数据脚本（无依赖，直接 node 跑）；**audit.js = 操作后自查，必跑**
├── tasks/                 ← 盯盘：check-alerts.ps1 / run-hidden.vbs / alerts.log
├── backtest/              ← 回测引擎与各项研究（改规则前先看这里有没有测过）
└── *.json                 ← watchlist/positions/trades/events(手改) + alerts(自动生成)
```

**手动维护**：`watchlist.json` `positions.json` `trades.json` `events.json`
**自动生成，别手改**：`alerts.json`（每日重布防会覆盖）、`tasks/alerts-state.json`、`cache/`
