param(
  [ValidateSet('start', 'stop', 'status', 'new-session')][string]$Action = 'start',
  [switch]$NoBrowser,
  [string]$LanAddress,
  [switch]$HttpLan,
  [string]$EpsonAddress,
  [string]$EpsonProfile = 'printer-kitchen',
  [switch]$EpsonAuto,
  [string]$TestRoot,
  [int]$Port = 4273
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $projectRoot 'runtime\node.exe'
$nodeRuntime = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$arguments = @((Join-Path $PSScriptRoot 'safe-test.mjs'), $Action, '--port', [string]$Port)
if ($NoBrowser) { $arguments += '--no-browser' }
if ($LanAddress) { $arguments += @('--lan', $LanAddress) }
if ($HttpLan) { $arguments += '--http-lan' }
if ($EpsonAddress) { $arguments += @('--epson', $EpsonAddress, '--epson-profile', $EpsonProfile) }
if ($EpsonAuto) { $arguments += '--epson-auto' }
if ($TestRoot) { $arguments += @('--root', $TestRoot) }
& $nodeRuntime @arguments
exit $LASTEXITCODE
