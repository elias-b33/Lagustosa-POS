$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$releaseRoot = Join-Path $projectRoot 'releases'
$releaseName = 'lagustosa-training-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$packagePath = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot $releaseName))
if (-not $packagePath.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Ogiltig paketsökväg.' }
if (Test-Path -LiteralPath $packagePath) { throw 'Paketmappen finns redan.' }
Push-Location -LiteralPath $projectRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Bygget misslyckades.' }
  New-Item -ItemType Directory -Path $packagePath -Force | Out-Null
  foreach ($item in @('dist','vendor','scripts','package.json','package-lock.json','README.md','.env.example','Start-Lagustosa.cmd')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $packagePath -Recurse
  }
  New-Item -ItemType Directory -Path (Join-Path $packagePath 'runtime') | Out-Null
  Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $packagePath 'runtime\node.exe')
  Push-Location -LiteralPath $packagePath
  try {
    & npm.cmd ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installation av driftberoenden misslyckades.' }
  } finally { Pop-Location }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = Join-Path $releaseRoot ($releaseName + '.zip')
  [System.IO.Compression.ZipFile]::CreateFromDirectory($packagePath, $zipPath)
  Write-Output ('Windows-paket skapat: ' + $zipPath)
} finally { Pop-Location }
