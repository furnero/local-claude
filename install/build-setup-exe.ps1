# Wraps install.cmd + install.ps1 into one file, install\out\LocalClaudeSetup.exe, with IExpress
# (part of Windows). The exe holds only the installer script: it is a few hundred KB and fetches
# the app from GitHub when it runs, so it only works once this version is pushed there.
#   powershell -ExecutionPolicy Bypass -File install\build-setup-exe.ps1
# Keep this file ASCII only.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Join-Path $here 'out'
$build = Join-Path $out 'build'
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force $build | Out-Null
$target = Join-Path $out 'LocalClaudeSetup.exe'
if (Test-Path $target) { Remove-Item $target -Force }
Copy-Item (Join-Path $here 'install.cmd') $build
Copy-Item (Join-Path $here 'install.ps1') $build

# IExpress is picky about paths: it runs inside the build folder and gets relative names
$lines = @(
  '[Version]'
  'Class=IEXPRESS'
  'SEDVersion=3'
  '[Options]'
  'PackagePurpose=InstallApp'
  'ShowInstallProgramWindow=1'
  'HideExtractAnimation=1'
  'UseLongFileName=1'
  'InsideCompressed=0'
  'CAB_FixedSize=0'
  'CAB_ResvCodeSigning=0'
  'RebootMode=N'
  'InstallPrompt=%InstallPrompt%'
  'DisplayLicense=%DisplayLicense%'
  'FinishMessage=%FinishMessage%'
  'TargetName=%TargetName%'
  'FriendlyName=%FriendlyName%'
  'AppLaunched=%AppLaunched%'
  'PostInstallCmd=%PostInstallCmd%'
  'AdminQuietInstCmd=%AdminQuietInstCmd%'
  'UserQuietInstCmd=%UserQuietInstCmd%'
  'SourceFiles=SourceFiles'
  '[Strings]'
  'InstallPrompt='
  'DisplayLicense='
  'FinishMessage='
  "TargetName=$target"
  'FriendlyName=Local Claude setup'
  'AppLaunched=cmd /c install.cmd'
  'PostInstallCmd=<None>'
  'AdminQuietInstCmd='
  'UserQuietInstCmd='
  'FILE0="install.cmd"'
  'FILE1="install.ps1"'
  '[SourceFiles]'
  'SourceFiles0=.\'
  '[SourceFiles0]'
  '%FILE0%='
  '%FILE1%='
)
Set-Content -Path (Join-Path $build 'setup.sed') -Value $lines -Encoding ASCII
Push-Location $build
try { & (Join-Path $env:SystemRoot 'System32\iexpress.exe') /N /Q /M setup.sed 2>&1 | Write-Output }
finally { Pop-Location }
# IExpress returns before the file is fully written
for ($i = 0; $i -lt 40 -and -not (Test-Path $target); $i++) { Start-Sleep -Milliseconds 250 }
Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
if (-not (Test-Path $target)) { throw "IExpress did not produce $target." }
$f = Get-Item $target
"Built $($f.FullName) ($([Math]::Round($f.Length / 1KB)) KB)"
