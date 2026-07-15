@echo off
chcp 936 >nul
title 自选股报价 - 按任意键刷新
color 0A
cls
echo ============================================
echo      自选股实时报价 (按任意键刷新)
echo      Ctrl+C 退出
echo ============================================
echo.

:loop
echo 时间: %date% %time%
echo --------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$codes=((Get-Content -Raw -Encoding UTF8 'D:\AI\workspace\stock\watchlist.json' ^| ConvertFrom-Json).stocks.tencent) -join ','; ^
$url='http://qt.gtimg.cn/q='+$codes; ^
$r=Invoke-WebRequest -Uri $url -TimeoutSec 8 -UseBasicParsing; ^
$segments=$r.Content -split ';'; ^
foreach($seg in $segments){ ^
  if($seg -match '~(.+?)~(.+?)~(.+?)~(.+?)~(.+?)~'){ ^
    $f=$seg -split '~'; ^
    $name=$f[1];$code=$f[2];$cur=[double]$f[3];$pre=[double]$f[4];$chg=$cur-$pre; ^
    $pct=if($pre -gt 0){[math]::Round($chg/$pre*100,2)}else{0}; ^
    $s=if($chg -ge 0){'+'}else{''}; ^
    Write-Host (\"{0,-8} {1,8}`t{2} {3,6}({4}%)\" -f $code,$cur,$s,[math]::Round($chg,2),[math]::Round($pct,2)) ^
  } ^
}" 2>nul
echo --------------------------------------------
echo.
pause >nul
cls
goto loop
