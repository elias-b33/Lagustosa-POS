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
  foreach ($item in @('dist','vendor','scripts','package.json','package-lock.json','README.md','TEST-GUIDE.md','.env.example','Start-Lagustosa.cmd','Start-Testmiljo.cmd','Stoppa-Testmiljo.cmd','Ny-Testomgang.cmd')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $packagePath -Recurse
  }
  New-Item -ItemType Directory -Path (Join-Path $packagePath 'runtime') | Out-Null
  Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $packagePath 'runtime\node.exe')
  Push-Location -LiteralPath $packagePath
  try {
    & npm.cmd ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installation av driftberoenden misslyckades.' }
  } finally { Pop-Location }
  $sourceCommit = $null
  $workingTreeDirty = $null
  if (Get-Command git.exe -ErrorAction SilentlyContinue) {
    $sourceCommit = & git.exe -C $projectRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0) { $workingTreeDirty = [bool](& git.exe -C $projectRoot status --porcelain) } else { $sourceCommit = $null }
  }
  $buildInfo = [ordered]@{
    application = 'Lagustosa POS'
    mode = 'training'
    createdAt = [DateTime]::UtcNow.ToString('o')
    sourceCommit = $sourceCommit
    workingTreeDirty = $workingTreeDirty
    nodeVersion = (& node.exe --version)
    architecture = (& node.exe -p 'process.arch')
    payment = 'simulator'
    fiscal = 'simulator'
    print = 'preview'
    defaultLauncher = 'Start-Testmiljo.cmd'
  }
  [System.IO.File]::WriteAllText((Join-Path $packagePath 'BUILD-INFO.json'), ($buildInfo | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = Join-Path $releaseRoot ($releaseName + '.zip')
  [System.IO.Compression.ZipFile]::CreateFromDirectory($packagePath, $zipPath)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  $zipStream = [System.IO.File]::OpenRead($zipPath)
  try { $sha256 = [System.BitConverter]::ToString($hasher.ComputeHash($zipStream)).Replace('-', '').ToLowerInvariant() }
  finally { $zipStream.Dispose(); $hasher.Dispose() }
  [System.IO.File]::WriteAllText(($zipPath + '.sha256'), ($sha256 + '  ' + [System.IO.Path]::GetFileName($zipPath) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('Windows-paket skapat: ' + $zipPath)
  Write-Output ('SHA-256: ' + $sha256)
} finally { Pop-Location }
