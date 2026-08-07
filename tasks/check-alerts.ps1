# Zero-token stock alert. Reads ../alerts.json, fetches prices, pops/logs on hit.
# Called by Windows Task Scheduler every 3 min. No LLM involved = 0 token.
# Source is ASCII-only (PowerShell 5.1 misreads non-ASCII .ps1 without BOM).
# Chinese only lives in alerts.json data / confirm.js output (captured as UTF8) -> shows fine.
#
# Semantics:
#   - Price alert: EDGE-TRIGGERED with hysteresis re-arm. Fires when price crosses INTO the
#     zone; does not re-fire every 3 min while parked; re-arms after clearing out by ReArmBuffer.
#   - Auto-refresh (twice/day): first tick >=09:30 and first tick >=13:30 run scripts/arm-alerts.js
#     to regenerate/re-track levels. The 13:30 pass re-includes stocks that recovered over the
#     morning (levels never go stale; afternoon recoveries get picked up). Skipped in -Test.
#   - "confirm": true alerts: while price is in the zone, auto-run scripts/confirm.js (3-check)
#     every cycle. The entry popup shows the current 3-check; when the verdict FIRST turns PASS
#     during a dip, an extra "PASS" popup fires (latched, one per dip) so you get pinged the
#     moment it becomes a real buy -- no need to ask manually.
#   - Crash gate: 3-index avg change <= -1.5% -> silence ALL alerts (crash = 0% territory, all knives);
#     and fire ONE "all-clear" popup on the first clearly-up day (avg >= +0.8%) after a crash spell,
#     so a non-watching user gets pinged to re-engage without being spammed during the fall.
#   - State (armed/passed/crashMode) is written BEFORE the blocking popup so overlapping runs dedup.
# Manual test (dry-run, no popup/log/state/refresh): powershell -ExecutionPolicy Bypass -File check-alerts.ps1 -Test
param([switch]$Test)
$ErrorActionPreference = 'Stop'

$AlertMode = 'popup'        # popup | sound | log
$ReArmBuffer = 0.005        # 0.5% clearance required to re-arm (anti-flutter)

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = 'D:\AI\workspace\stock' }
$alertsFile = Join-Path $root 'alerts.json'
$logFile = Join-Path $PSScriptRoot 'alerts.log'
$stateFile = Join-Path $PSScriptRoot 'alerts-state.json'

# Run scripts/confirm.js (3-check) for a tencent code; return @{ text; verdict }.
function Get-ConfirmObj($tencent, $root) {
    $res = @{ text = ''; verdict = 'ERR' }
    $secid = ''
    if ($tencent -match '^sz(\d+)$') { $secid = '0.' + $matches[1] }
    elseif ($tencent -match '^sh(\d+)$') { $secid = '1.' + $matches[1] }
    if (-not $secid) { return $res }
    $confirmJs = Join-Path $root 'scripts\confirm.js'
    if (-not (Test-Path $confirmJs)) { return $res }
    $prev = $null
    try { $prev = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    $out = @()
    try { $out = @(& node $confirmJs $secid) } catch { $out = @() }
    if ($prev) { try { [Console]::OutputEncoding = $prev } catch {} }
    if (-not $out -or $out.Count -eq 0) { $res.text = '  [confirm.js no output - check manually]'; return $res }
    $res.text = ($out -join "`n")
    $vLine = $out | Where-Object { $_ -match 'VERDICT:' } | Select-Object -First 1
    if ($vLine -match 'VERDICT:\s*(\w+)') { $res.verdict = $matches[1] }
    return $res
}

# Trading session gate (skipped in -Test)
if (-not $Test) {
    $now = Get-Date
    $dow = [int]$now.DayOfWeek
    if ($dow -eq 0 -or $dow -eq 6) { exit 0 }
    $hm = $now.Hour * 100 + $now.Minute
    $inSession = ($hm -ge 930 -and $hm -le 1130) -or ($hm -ge 1300 -and $hm -le 1500)
    if (-not $inSession) { exit 0 }
}

# Load state (armed + passed maps). Only honored when the stored date == today.
$today = (Get-Date -Format 'yyyy-MM-dd')
$armed = @{}; $passed = @{}; $stateDate = ''; $armMark = ''; $crashMode = $false
if (Test-Path $stateFile) {
    try {
        $st = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $stateDate = [string]$st.date
        if ($null -ne $st.crashMode) { $crashMode = [bool]$st.crashMode }   # persists across days
        if ($st.date -eq $today) {
            if ($st.armed) { foreach ($p in $st.armed.PSObject.Properties) { $armed[$p.Name] = [bool]$p.Value } }
            if ($st.passed) { foreach ($p in $st.passed.PSObject.Properties) { $passed[$p.Name] = [bool]$p.Value } }
            $armMark = [string]$st.arm
        }
    } catch {}
}

# Auto-refresh alert levels twice a day: first tick >=09:30 (AM window) and first tick >=13:30 (PM window).
# The 13:30 pass re-includes stocks that recovered buy-posture over the morning (main-force back / reclaimed MA).
if (-not $Test) {
    $hmNow = (Get-Date).Hour * 100 + (Get-Date).Minute
    $curWin = if ($hmNow -ge 1330) { "$today/PM" } else { "$today/AM" }
    if ($armMark -ne $curWin) {
        $armJs = Join-Path $root 'scripts\arm-alerts.js'
        if (Test-Path $armJs) { try { & node $armJs | Out-Null } catch {} }
        # v2.6: after refreshing watchlist BUY watches, arm holding STOP/trailing/add alerts from positions.json
        $posJs = Join-Path $root 'scripts\arm-positions.js'
        if (Test-Path $posJs) { try { & node $posJs | Out-Null } catch {} }
        $armMark = $curWin
    }
}

$cfg = Get-Content -LiteralPath $alertsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$alerts = @($cfg.alerts | Where-Object { $_.enabled })
if (-not $alerts) { exit 0 }

# Fetch quotes (Tencent) + 3 index codes for a market-crash gate.
$idxCodes = @('sh000001', 'sz399001', 'sz399006')
$codes = (@($alerts.tencent) + $idxCodes) -join ','
$resp = Invoke-WebRequest -Uri "http://qt.gtimg.cn/q=$codes" -TimeoutSec 8 -UseBasicParsing
$priceMap = @{}; $prevMap = @{}
foreach ($seg in ($resp.Content -split ';')) {
    if ($seg -match 'v_(\w+)="([^"]+)"') {
        $f = $matches[2] -split '~'
        if ($f.Count -ge 5) { $priceMap[$matches[1]] = [double]$f[3]; $prevMap[$matches[1]] = [double]$f[4] }
    }
}
# Market-crash gate: 3-index avg change <= -1.5% -> silence pullback-buy alerts (all knives in a crash).
$idxPct = @()
foreach ($ic in $idxCodes) { if ($prevMap.ContainsKey($ic) -and $prevMap[$ic] -gt 0) { $idxPct += ($priceMap[$ic] - $prevMap[$ic]) / $prevMap[$ic] * 100 } }
$avgIdx = if ($idxPct.Count) { ($idxPct | Measure-Object -Average).Average } else { 0 }
$crashGate = ($idxPct.Count -ge 2) -and ($avgIdx -le -1.5)

$hits = @()
foreach ($a in $alerts) {
    $code = $a.tencent
    $price = $priceMap[$code]
    if ($null -eq $price) { continue }
    $thr = [double]$a.price
    # 2026-08-07 fix: armed/passed state MUST be keyed per-alert, not per-stock.
    # With arm-positions a stock carries several alerts (stop/add/trail) sharing one tencent
    # code; a shared flag let one alert's re-arm branch re-arm ANOTHER alert every cycle
    # (add-watch popped every minute), and one alert's fire could silence a sibling stop alert.
    $key = "$code|$($a.name)"
    $isArmed = if ($armed.ContainsKey($key)) { $armed[$key] }
               elseif ($a.op -eq '>') {
                   # Seed "armed" from prevClose, not the current instant price (2026-07-22 lesson:
                   # a fast limit-up open can already be past thr by the first poll of the day,
                   # which used to be misread as "already fired" and silenced the alert all day).
                   # prevClose <= thr means today is a fresh cross -> should be armed.
                   if ($prevMap.ContainsKey($code)) { $prevMap[$code] -le $thr } else { $price -le $thr }
               }
               else { $true }
    $wasPassed = if ($passed.ContainsKey($key)) { $passed[$key] } else { $false }
    $hit = switch ($a.op) {
        '>=' { $price -ge $thr }
        '<=' { $price -le $thr }
        '>'  { $price -gt $thr }
        '<'  { $price -lt $thr }
        default { $false }
    }
    # re-arm only when price clears back out of the zone by the buffer
    $reset = switch ($a.op) {
        '>=' { $price -le $thr * (1 - $ReArmBuffer) }
        '>'  { $price -le $thr * (1 - $ReArmBuffer) }
        '<=' { $price -ge $thr * (1 + $ReArmBuffer) }
        '<'  { $price -ge $thr * (1 + $ReArmBuffer) }
        default { $false }
    }

    # confirm:true + in-zone -> run 3-check each cycle (skip in -Test to keep it light)
    $confObj = $null
    if (-not $Test -and $a.confirm -and $hit) { $confObj = Get-ConfirmObj $code $root }

    # price-edge entry fire (heads-up). Confirm alerts are gated to PASS below, so they do NOT
    # pop on a raw price touch -- only the 3-check PASS verdict pops (no "falling-knife" popups).
    if ($hit -and $isArmed -and -not $a.confirm) {
        $hits += [pscustomobject]@{ name = $a.name; price = $price; msg = $a.msg; text = $(if ($confObj) { $confObj.text } else { '' }); sell = [bool]$a.sell }
        $armed[$key] = $false
    }
    elseif ($reset) {
        $armed[$key] = $true
    }
    else {
        $armed[$key] = $isArmed
    }

    # verdict-edge PASS fire (only once per dip): the moment 3-check turns PASS
    $passedNow = $wasPassed
    if ($confObj -and $confObj.verdict -eq 'PASS' -and -not $wasPassed) {
        $hits += [pscustomobject]@{ name = $a.name; price = $price; msg = 'PASS - 3-check all green -> consider buy, ping me'; text = $confObj.text; sell = $false }
        $passedNow = $true
    }
    if ($reset) { $passedNow = $false }
    $passed[$key] = $passedNow

    if ($Test) {
        $arm = if ($armed[$key]) { 'armed' } else { 'fired/parked' }
        Write-Host ("{0} {1} price={2} cond {3}{4} hit={5} -> {6}" -f $a.name, $code, $price, $a.op, $thr, $hit, $arm)
    }
}

if ($Test) {
    Write-Host ("[regime] 3-idx avg {0}%  crashGate={1}  crashMode(in)={2}" -f ([math]::Round($avgIdx, 2)), $crashGate, $crashMode)
    if ($hits.Count -gt 0) {
        Write-Host "--- WOULD FIRE $($hits.Count)$(if ($crashGate) { ' -- crash gate: BUY silenced, SELL/STOP still fires' }) (test mode: no popup/log/state/refresh) ---"
        $hits | ForEach-Object { Write-Host ("{0} {1} - {2}" -f $_.name, $_.price, $_.msg) }
    } else { Write-Host "--- no NEW crossing ---" }
    exit 0
}

# Market-regime transition: track crash spell (crashMode) + detect first recovery day (all-clear).
$allClear = $false
if ($crashGate) { $crashMode = $true }
elseif ($crashMode -and $avgIdx -ge 0.8 -and (@($idxPct | Where-Object { $_ -gt 0 }).Count -ge 2)) { $allClear = $true; $crashMode = $false }

# Persist state FIRST (before any blocking popup) so overlapping runs dedup correctly.
@{ date = $today; armed = $armed; passed = $passed; arm = $armMark; crashMode = $crashMode } | ConvertTo-Json -Compress | Out-File -FilePath $stateFile -Encoding utf8

# Market crashing (3-idx avg <= -1.5%) -> silence BUY/pullback alerts (all knives in a crash). Log once, no popup.
# v2.6 fix: a crash is EXACTLY when a stop-loss must still ping -> SELL/STOP alerts (sell=true) are NOT silenced.
if ($crashGate) {
    $buyHits = @($hits | Where-Object { -not $_.sell })
    $sellHits = @($hits | Where-Object { $_.sell })
    if ($buyHits.Count -gt 0) { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] CRASH-SILENCE (3idx avg $([math]::Round($avgIdx, 2))%): suppressed $($buyHits.Count) buy alerts" | Out-File -FilePath $logFile -Append -Encoding utf8 }
    if ($sellHits.Count -eq 0) { exit 0 }
    $hits = $sellHits   # only SELL/STOP alerts survive the crash gate -> fall through to popup below
}

# Market recovery all-clear: first clearly-up day after a crash spell -> ONE popup to re-engage.
if ($allClear) {
    $ts = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    $acMsg = "MARKET ALL-CLEAR: 3-idx avg +$([math]::Round($avgIdx, 2))% (crash paused). Re-engage -> ask Claude to run market.js. NOTE: one up-day != stabilized."
    "[$ts] $acMsg" | Out-File -FilePath $logFile -Append -Encoding utf8
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($acMsg, "Market All-Clear $ts", "OK", "Information") | Out-Null
}

if ($hits.Count -gt 0) {
    $ts = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    # v2.6: 09:30-10:00 is the noisiest window (open auction + overnight imbalance + overseas beta).
    # A single tick touching a level is a "space event", not a "space-time event" (held for time).
    # Tag popups fired in this window as LOOK-ONLY so the user does not act on the opening spike.
    $hmFire = (Get-Date).Hour * 100 + (Get-Date).Minute
    $noiseWin = ($hmFire -ge 930 -and $hmFire -lt 1000)
    $body = ($hits | ForEach-Object {
            $line = "$($_.name) $($_.price) - $($_.msg)"
            if ($_.sell) {
                $line = $line + "`n  >>> STOP/SELL alert -> verify real volume-break vs morning wick, then act per plan (ping Claude)"
            }
            elseif ($_.text) {
                $line = $line + "  [AUTO-CONFIRMED / 3-check ok -> read VERDICT below]`n----- " + $_.name + " 3-check -----`n" + $_.text
            }
            else {
                $line = $line + "`n  >>> PRICE-ONLY, NOT auto-confirmed -> ping Claude to confirm (main-force/vol/MA10)"
            }
            $line
        }) -join "`n"
    if ($noiseWin) {
        $banner = "[!] 09:30-10:00 OPEN NOISE WINDOW: price touch = LOOK ONLY, do NOT act on the opening spike." + "`n" +
                  "    SELL/STOP only if it breaks today's low, OR is still below stop after 10:00." + "`n" +
                  "    BUY only if the level still holds past 10:00 + confirm." + "`n" +
                  "    (Exception: -8% disaster line / clear bad-news gap = act immediately.)" + "`n`n"
        $body = $banner + $body
    }
    "[$ts]`n$body" | Out-File -FilePath $logFile -Append -Encoding utf8
    switch ($AlertMode) {
        'popup' {
            Add-Type -AssemblyName PresentationFramework
            [System.Windows.MessageBox]::Show($body, "Stock Alert $ts", "OK", "Information") | Out-Null
        }
        'sound' { 1..3 | ForEach-Object { [console]::beep(880, 300) } }
    }
}
