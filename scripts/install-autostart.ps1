$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $projectRoot 'runtime\node.exe'
$nodeRuntime = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$serverFile = Join-Path $projectRoot 'dist\server\index.js'
if (-not (Test-Path -LiteralPath $serverFile)) { throw 'Bygg projektet innan automatisk start installeras.' }
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $nodeRuntime -Argument ('"' + $serverFile + '"') -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$settings.Hidden = $true
Register-ScheduledTask -TaskName 'Lagustosa-Kassa-Training' -Action $action -Trigger $trigger -Settings $settings -Description 'Lagustosas lokala träningskassa. Startar när restaurangens konto loggar in.' -User $account -RunLevel Limited -Force | Out-Null
Write-Output 'Automatisk start är installerad för detta konto vid inloggning.'
