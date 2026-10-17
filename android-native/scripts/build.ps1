param([switch]$Release,[switch]$Instrumented,[switch]$DebugBuild)
$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $PSScriptRoot
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'RestaurantPosBuild\sdk' }
$javaRoot = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'C:\Program Files\Android\openjdk\jdk-21.0.8' }
if (!(Test-Path -LiteralPath (Join-Path $sdkRoot 'platforms\android-35\android.jar'))) { throw 'Android SDK Platform 35 saknas. Ange ANDROID_HOME.' }
if (!(Test-Path -LiteralPath (Join-Path $javaRoot 'bin\javac.exe'))) { throw 'JDK 17 eller 21 saknas. Ange JAVA_HOME.' }
$env:JAVA_HOME = $javaRoot
$env:ANDROID_HOME = $sdkRoot
$env:GRADLE_USER_HOME = Join-Path $env:LOCALAPPDATA 'RestaurantPosBuild\gradle-cache'
Push-Location $nativeRoot
try {
    $variant = if ($Release) { 'Release' } elseif ($DebugBuild) { 'Debug' } else { 'Optimized' }
    $task = ":app:assemble$variant"
    $tasks = @($task, ':app:testDebugUnitTest', ':app:lintDebug')
    if ($Instrumented) { $tasks += ':app:assembleDebugAndroidTest', ':smoke:assembleOptimized' }
    & '.\gradlew.bat' --no-daemon --console=plain @tasks
    if ($LASTEXITCODE -ne 0) { throw 'Native-bygget misslyckades.' }
    New-Item -ItemType Directory -Force 'releases' | Out-Null
    if ($Release) { Copy-Item -LiteralPath 'app\build\outputs\apk\release\app-release-unsigned.apk' -Destination 'releases\Restaurangkassa-native-unsigned.apk' }
    else { Copy-Item -LiteralPath "app\build\outputs\apk\$($variant.ToLower())\app-$($variant.ToLower()).apk" -Destination 'releases\Restaurangkassa-native-test.apk' }
    Write-Output "APK: $nativeRoot\releases"
} finally { Pop-Location }
