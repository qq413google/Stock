$ErrorActionPreference = 'Stop'

$title = 'Stock Watchlist Reminder 09:20'
$message = @(
    'Tomorrow watchlist:'
    ''
    '1. Lens Technology 300433'
    '   - Watch reclaim 44.80 after open'
    '   - Consider only above 45.00; avoid below 44.30'
    ''
    '2. ZTT 600522'
    '   - Watch 45.60 reclaim'
    '   - Small position only if stable; give up below 45.20'
    ''
    '3. Changchuan Tech 300604'
    '   - Watch reclaim 216.00'
    '   - Give up below 213.00'
    ''
    '4. TFME 002156'
    '   - Watch limit-up strength and order queue'
    '   - Do not chase if it opens weak'
    ''
    '5. HGTech 000988'
    '   - Weak below intraday average'
    '   - Consider only after strong reclaim with volume'
    ''
    'Rules:'
    '- Do not rush before open; observe 15-30 minutes after 09:30.'
    '- Do not open new position if index and hot sectors keep falling.'
    '- Max 1 lot per stock; protect yesterday Lens profit first.'
) -join [Environment]::NewLine

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'tasks'
$logFile = Join-Path $logDir 'stock-watchlist-reminder.log'
$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

Add-Content -LiteralPath $logFile -Value "[$timestamp] $title`r`n$message`r`n"

try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($message, $title, 'OK', 'Information') | Out-Null
} catch {
    $shortMessage = ($message -split [Environment]::NewLine)[0..8] -join ' | '
    msg.exe $env:USERNAME "$title - $shortMessage" | Out-Null
}
