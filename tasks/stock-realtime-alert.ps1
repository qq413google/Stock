# Stock Realtime Alert - 盘中每5分钟弹窗报价
# 仅在交易时段(9:30-11:30, 13:00-15:00)工作日运行

$ErrorActionPreference = "Stop"

# 检查是否交易时间
$now = Get-Date
$dow = [int]$now.DayOfWeek
if ($dow -eq 0 -or $dow -eq 6) { exit 0 }  # 周末退出

$hm = $now.Hour * 100 + $now.Minute
$inSession = ($hm -ge 930 -and $hm -le 1130) -or ($hm -ge 1300 -and $hm -le 1500)
if (-not $inSession) { exit 0 }

# 关注股票代码（单一数据源 watchlist.json）
$wl = Join-Path (Split-Path -Parent $PSScriptRoot) 'watchlist.json'
$codeStr = ((Get-Content -LiteralPath $wl -Raw -Encoding UTF8 | ConvertFrom-Json).stocks.tencent) -join ","
$url = "http://qt.gtimg.cn/q=$codeStr"

try {
    $resp = Invoke-WebRequest -Uri $url -TimeoutSec 8 -UseBasicParsing
    $lines = $resp.Content -split ";"

    $msgLines = @()
    $msgLines += "=== 盘中实时报价 $(Get-Date -Format 'HH:mm:ss') ==="

    foreach ($line in $lines) {
        if ($line -match '^v_(.+?)="(.+?)"$') {
            $data = $matches[2]
            $fields = $data -split "~"
            if ($fields.Count -ge 7) {
                $name = $fields[1]
                $code = $fields[2]
                $price = [double]$fields[3]
                $preClose = [double]$fields[4]
                if ($preClose -gt 0) {
                    $chg = $price - $preClose
                    $pct = [math]::Round($chg / $preClose * 100, 2)
                    $sign = if ($chg -ge 0) { "+" } else { "" }
                    $color = if ($chg -ge 0) { "🔴" } else { "🟢" }  # A股: 红涨绿跌
                    $msgLines += "$color $name($code)  $price  $sign$chg ($sign$pct%)"
                }
            }
        }
    }

    $msgLines += "================================"
    $msg = $msgLines -join "`n"

    # 弹窗显示（用 .NET MessageBox，无乱码）
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($msg, "Stock Alert", "OK", "Information") | Out-Null

} catch {
    # 静默失败，写日志
    $log = "D:\AI\workspace\stock\tasks\stock-realtime-alert.log"
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8
}