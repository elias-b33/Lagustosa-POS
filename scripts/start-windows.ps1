$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $projectRoot 'runtime\node.exe'
$serverFile = Join-Path $projectRoot 'dist\server\index.js'
if (-not (Test-Path -LiteralPath $serverFile)) { throw 'Bygg projektet först med npm run build.' }
$nodeRuntime = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
Start-Process -FilePath $nodeRuntime -ArgumentList @('dist/server/index.js') -WorkingDirectory $projectRoot -WindowStyle Hidden
Write-Output 'Kassaservern startas i bakgrunden. Lokal adress: http://127.0.0.1:4173 (HTTPS om certifikat aktiverats i .env).'
