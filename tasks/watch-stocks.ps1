Write-Host "============================================"
Write-Host "  ZI XUAN GU SHI SHI BIAO JIA  (Ctrl+C tui chu)"
Write-Host "============================================"
Write-Host ""

while ($true) {
    Write-Host "--------------------------------------------"
    Write-Host "SHI JIAN: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Host ""
    $wl = Join-Path (Split-Path -Parent $PSScriptRoot) 'watchlist.json'
    $codes = ((Get-Content -LiteralPath $wl -Raw -Encoding UTF8 | ConvertFrom-Json).stocks.tencent) -join ","
    $url = "http://qt.gtimg.cn/q=$codes"
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 8 -UseBasicParsing
        $segments = $r.Content -split ";"
        foreach ($seg in $segments) {
            if ($seg -match '~(.+?)~(.+?)~(.+?)~(.+?)~(.+?)~') {
                $f = $seg -split "~"
                $code = $f[2]
                $cur = [double]$f[3]
                $pre = [double]$f[4]
                $chg = $cur - $pre
                $pct = if ($pre -gt 0) { [math]::Round($chg / $pre * 100, 2) } else { 0 }
                $sign = if ($chg -ge 0) { "+" } else { "" }
                Write-Host ("  {0,-8} {1,8}  {2}{3} ({4}{5}%)" -f $code, $cur, $sign, [math]::Round($chg, 2), $sign, $pct)
            }
        }
    } catch {
        Write-Host "  [ERROR] fetch failed"
    }
    Write-Host "--------------------------------------------"
    Write-Host "Press any key to refresh, Ctrl+C to exit"
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Clear-Host
}