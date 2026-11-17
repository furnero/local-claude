# Local Claude installer (Windows 10/11, PowerShell 5.1). Start it with install.cmd.
#
# Step 1 installs what is missing (Ollama, Node.js), puts the app into the install folder,
# builds LocalClaude.exe and makes the shortcuts.
# Step 2 shows the PC's hardware and one model list per mode: the models the app knows and
# whatever is installed in Ollama already. The recommended one is preselected. Downloads go
# straight into Ollama's own model folder; the optional Coder 30B model goes into the colibri
# folders chosen here, and the app's settings point at them afterwards.
#
# The hardware rules are not repeated here: the window asks app\scripts\setup-cli.js, which
# uses the same code as the app.
#
# Keep this file ASCII only: PowerShell 5.1 reads a script without a BOM as ANSI.
param(
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'LocalClaude'),
  [switch]$SelfTest,          # build the window, print what was found, save a picture, change nothing
  [string]$SelfTestPicture
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$Repo = 'furnero/local-claude'
$SourceZip = "https://github.com/$Repo/archive/refs/heads/main.zip"
$OllamaSetup = 'https://ollama.com/download/OllamaSetup.exe'

# ---------------------------------------------------------------- what is on this PC

function Update-Path {
  # programs installed a moment ago are not on this process's PATH yet
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}
function Find-Cmd([string]$name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}
function Find-Ollama {
  $p = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if (Test-Path $p) { return $p }
  return (Find-Cmd 'ollama.exe')
}
function Find-Node {
  $n = Find-Cmd 'node.exe'
  if (-not $n) {
    $p = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $p) { $n = $p }
  }
  if (-not $n) { return $null }
  try {
    $v = (& $n --version) -replace '^v', ''
    if ([int]($v.Split('.')[0]) -ge 20) { return $n }
  } catch {}
  return $null   # too old counts as missing
}
function Find-Npm {
  $node = Find-Node
  if ($node) {
    $p = Join-Path (Split-Path $node) 'npm.cmd'
    if (Test-Path $p) { return $p }
  }
  return (Find-Cmd 'npm.cmd')
}
function Find-Python {
  foreach ($c in @('py.exe', 'python.exe')) {
    $p = Find-Cmd $c
    # the Microsoft Store placeholder is not a real Python
    if ($p -and $p -notlike '*\WindowsApps\*') { return $p }
  }
  return $null
}
$Winget = Find-Cmd 'winget.exe'

# ---------------------------------------------------------------- window

$font = New-Object Drawing.Font('Segoe UI', 9)
$form = New-Object Windows.Forms.Form
$form.Text = 'Local Claude setup'
$form.Font = $font
$form.ClientSize = New-Object Drawing.Size(700, 650)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'

function New-Label([string]$text, [int]$x, [int]$y, [int]$w, [int]$h = 20, $parent = $form) {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text
  $l.SetBounds($x, $y, $w, $h)
  $parent.Controls.Add($l)
  return $l
}
function New-Check([string]$text, [int]$x, [int]$y, [int]$w, $parent) {
  $c = New-Object Windows.Forms.CheckBox
  $c.Text = $text
  $c.SetBounds($x, $y, $w, 22)
  $parent.Controls.Add($c)
  return $c
}
function New-Button([string]$text, [int]$x, [int]$y, [int]$w, $parent) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text
  $b.SetBounds($x, $y, $w, 28)
  $parent.Controls.Add($b)
  return $b
}
function New-Text([string]$text, [int]$x, [int]$y, [int]$w, $parent) {
  $t = New-Object Windows.Forms.TextBox
  $t.Text = $text
  $t.SetBounds($x, $y, $w, 23)
  $parent.Controls.Add($t)
  return $t
}
function Pick-Folder($box) {
  $d = New-Object Windows.Forms.FolderBrowserDialog
  if ($box.Text -and (Test-Path $box.Text)) { $d.SelectedPath = $box.Text }
  if ($d.ShowDialog($form) -eq 'OK') { $box.Text = $d.SelectedPath }
}

$title = New-Label 'Local Claude' 20 14 660 28
$title.Font = New-Object Drawing.Font('Segoe UI', 14, [Drawing.FontStyle]::Bold)
$subtitle = New-Label 'An offline chat app on local models. Not Claude, not affiliated with Anthropic.' 20 44 660

# ---- step 1: programs
$p1 = New-Object Windows.Forms.Panel
$p1.SetBounds(20, 74, 660, 330)
$form.Controls.Add($p1)
$h1 = New-Label 'Step 1 of 2: programs' 0 0 400 20 $p1
$h1.Font = New-Object Drawing.Font('Segoe UI', 9, [Drawing.FontStyle]::Bold)
New-Label 'Install folder' 0 32 100 20 $p1 | Out-Null
$dirBox = New-Text $Dir 100 29 460 $p1
$dirBtn = New-Button 'Browse' 570 26 90 $p1
$dirBtn.Add_Click({ Pick-Folder $dirBox })

$cbOllama = New-Check '' 0 70 660 $p1
$cbNode = New-Check '' 0 96 660 $p1
$cbTerminal = New-Check 'Terminal launcher (also installs Claude Code; it talks to the local models, no login)' 0 122 660 $p1
$cbStart = New-Check 'Start menu shortcut' 0 158 300 $p1
$cbStart.Checked = $true
$cbDesk = New-Check 'Desktop shortcut' 0 184 300 $p1
$note1 = New-Label '' 0 222 660 60 $p1
$goBtn = New-Button 'Install' 560 290 100 $p1

function Show-Found {
  if (Find-Ollama) { $cbOllama.Text = 'Ollama (runs the models): already installed'; $cbOllama.Checked = $true; $cbOllama.Enabled = $false }
  else { $cbOllama.Text = 'Ollama (runs the models): will be installed'; $cbOllama.Checked = $true; $cbOllama.Enabled = $false }
  if (Find-Node) { $cbNode.Text = 'Node.js (builds and runs the app): already installed'; $cbNode.Checked = $true; $cbNode.Enabled = $false }
  else { $cbNode.Text = 'Node.js (builds and runs the app): will be installed'; $cbNode.Checked = $true; $cbNode.Enabled = $false }
  if (-not $Winget -and (-not (Find-Ollama) -or -not (Find-Node))) {
    $note1.Text = 'winget (the Windows package manager) was not found. Ollama can still be downloaded directly. Node.js cannot: install it from nodejs.org first, then start this setup again.'
  } else {
    $note1.Text = 'Missing programs are installed with winget, the package manager that comes with Windows. Windows may ask for permission once for Node.js.'
  }
}
Show-Found

# ---- step 2: models
$p2 = New-Object Windows.Forms.Panel
$p2.SetBounds(20, 74, 660, 330)
$p2.Visible = $false
$form.Controls.Add($p2)
$h2 = New-Label 'Step 2 of 2: models for this PC' 0 0 400 20 $p2
$h2.Font = $h1.Font
$hwLine1 = New-Label '' 0 26 660 18 $p2
$hwLine2 = New-Label '' 0 44 660 18 $p2
$combos = @{}
$y = 72
foreach ($id in @('quick', 'smart', 'coder')) {
  New-Label ((Get-Culture).TextInfo.ToTitleCase($id)) 0 ($y + 3) 60 20 $p2 | Out-Null
  $c = New-Object Windows.Forms.ComboBox
  $c.DropDownStyle = 'DropDownList'
  $c.SetBounds(60, $y, 600, 23)
  $p2.Controls.Add($c)
  $combos[$id] = $c
  $y += 30
}
$notes2 = New-Label '' 0 164 660 34 $p2
$cb30 = New-Check 'Also set up Coder 30B: Qwen3-Coder 30B through the colibri engine (17 GB, very slow, optional)' 0 200 660 $p2
New-Label 'Engine folder' 18 229 90 20 $p2 | Out-Null
$engBox = New-Text '' 110 226 450 $p2
$engBtn = New-Button 'Browse' 570 223 90 $p2
$engBtn.Add_Click({ Pick-Folder $engBox })
New-Label 'Model folder' 18 257 90 20 $p2 | Out-Null
$modBox = New-Text '' 110 254 450 $p2
$modBtn = New-Button 'Browse' 570 251 90 $p2
$modBtn.Add_Click({ Pick-Folder $modBox })
$total2 = New-Label '' 0 296 380 20 $p2
$skipBtn = New-Button 'Skip' 440 290 100 $p2
$dlBtn = New-Button 'Download' 550 290 110 $p2

# ---- shared: status, progress, log
$status = New-Label 'Ready.' 20 412 660 20
$bar = New-Object Windows.Forms.ProgressBar
$bar.SetBounds(20, 434, 660, 14)
$form.Controls.Add($bar)
$log = New-Object Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.Font = New-Object Drawing.Font('Consolas', 8.5)
$log.SetBounds(20, 456, 660, 150)
$form.Controls.Add($log)
$closeBtn = New-Button 'Close' 580 614 100 $form
$closeBtn.Add_Click({ $form.Close() })
$startBtn = New-Button 'Start Local Claude' 420 614 150 $form
$startBtn.Visible = $false

function Write-Log([string]$text) {
  if (-not $text) { return }
  $log.AppendText($text.TrimEnd() + "`r`n")
}
function Set-Status([string]$text) {
  $status.Text = $text
  Write-Log $text
  [Windows.Forms.Application]::DoEvents()
}

# ---------------------------------------------------------------- running programs without freezing the window

$script:proc = $null
$script:busy = $false
# the block and line drawing characters that console progress bars are made of (written as codes: this file stays ASCII)
$BoxChars = '[' + [char]0x2580 + '-' + [char]0x259F + [char]0x2500 + '-' + [char]0x257F + ']'

# Runs a program, shows its output in the log while it runs and returns its exit code.
# Lines "PROGRESS <n> text", "STEP text", "DONE text", "ERROR text" (from setup-cli.js) drive the bar.
function Invoke-Step([string]$exe, [string]$arguments, [string]$workDir = $env:TEMP) {
  $out = [IO.Path]::GetTempFileName()
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/d /s /c `"`"$exe`" $arguments > `"$out`" 2>&1`""
  $psi.WorkingDirectory = $workDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:proc = [Diagnostics.Process]::Start($psi)
  $script:lastError = $null
  $pos = 0
  $rest = ''
  $read = {
    try {
      $fs = New-Object IO.FileStream($out, 'Open', 'Read', 'ReadWrite')
      $fs.Position = $pos
      $buf = New-Object byte[] ([Math]::Max(0, $fs.Length - $pos))
      $n = $fs.Read($buf, 0, $buf.Length)
      $fs.Close()
      if ($n -gt 0) {
        Set-Variable -Name pos -Value ($pos + $n) -Scope 1
        $text = $rest + [Text.Encoding]::UTF8.GetString($buf, 0, $n)
        $lines = $text -split "`n"
        Set-Variable -Name rest -Value $lines[-1] -Scope 1
        foreach ($raw in $lines[0..([Math]::Max(0, $lines.Count - 2))]) {
          if ($lines.Count -lt 2) { break }
          # a progress line redraws itself with carriage returns: keep what is shown last
          $line = (($raw -split "`r") | Where-Object { $_.Trim() } | Select-Object -Last 1)
          if (-not $line) { continue }
          $line = ($line -replace $BoxChars, '').Trim()
          if ($line.Length -lt 2) { continue }
          if ($line -match '^PROGRESS (\d+) (.*)$') { $bar.Value = [Math]::Min(100, [int]$Matches[1]); $status.Text = $Matches[2]; continue }
          if ($line -match '^STEP (.*)$') { $bar.Value = 0; $status.Text = $Matches[1]; Write-Log $Matches[1]; continue }
          if ($line -match '^DONE (.*)$') { $bar.Value = 100; $status.Text = $Matches[1]; Write-Log $Matches[1]; continue }
          if ($line -match '^ERROR (.*)$') { $script:lastError = $Matches[1]; Write-Log ('Problem: ' + $Matches[1]); continue }
          Write-Log $line
        }
      }
    } catch {}
  }
  while (-not $script:proc.HasExited) {
    & $read
    [Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 120
  }
  & $read
  if ($rest.Trim()) { Write-Log $rest.Trim() }
  $code = $script:proc.ExitCode
  $script:proc = $null
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  return $code
}

function Stop-Running {
  if ($script:proc -and -not $script:proc.HasExited) {
    try { Start-Process taskkill.exe -ArgumentList '/PID', $script:proc.Id, '/T', '/F' -WindowStyle Hidden -Wait } catch {}
  }
}

function Install-WithWinget([string]$id, [string]$name) {
  Set-Status "Installing $name ..."
  $code = Invoke-Step $Winget "install -e --id $id --accept-source-agreements --accept-package-agreements --silent --disable-interactivity"
  Update-Path
  return $code
}

# ---------------------------------------------------------------- step 1

function Get-Source([string]$target) {
  # run from a checkout or an unpacked download: use those files; otherwise fetch them from GitHub
  $local = Split-Path -Parent $PSScriptRoot
  if (-not (Test-Path (Join-Path $local 'app\package.json'))) {
    Set-Status 'Downloading Local Claude ...'
    $zip = Join-Path $env:TEMP 'local-claude-source.zip'
    $unz = Join-Path $env:TEMP 'local-claude-source'
    if (Test-Path $unz) { Remove-Item $unz -Recurse -Force }
    Invoke-WebRequest -Uri $SourceZip -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $unz -Force
    $local = (Get-ChildItem $unz -Directory | Select-Object -First 1).FullName
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path (Join-Path $local 'app\scripts\setup-cli.js'))) { throw 'The downloaded files are older than this installer (app\scripts\setup-cli.js is missing).' }
  if ([IO.Path]::GetFullPath($local).TrimEnd('\') -ieq [IO.Path]::GetFullPath($target).TrimEnd('\')) { return }  # installing in place
  Set-Status 'Copying the app ...'
  New-Item -ItemType Directory -Force $target | Out-Null
  # chats, settings and notes of an earlier install stay; build output and packages are made fresh
  $code = Invoke-Step 'robocopy.exe' "`"$local`" `"$target`" /E /NFL /NDL /NJH /NJS /NP /XD node_modules dist data notes .git out"
  if ($code -ge 8) { throw "Copying the app failed (robocopy $code)." }
}

function New-Shortcut([string]$lnk, [string]$exe) {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = Split-Path $exe
  $s.Description = 'Local Claude'
  $s.Save()
}

function Step-One {
  $target = $dirBox.Text.Trim()
  if (-not $target) { throw 'Choose an install folder.' }
  $script:target = $target

  if (-not (Find-Ollama)) {
    if ($Winget) { Install-WithWinget 'Ollama.Ollama' 'Ollama' | Out-Null }
    if (-not (Find-Ollama)) {
      Set-Status 'Downloading the Ollama installer ...'
      $exe = Join-Path $env:TEMP 'OllamaSetup.exe'
      Invoke-WebRequest -Uri $OllamaSetup -OutFile $exe -UseBasicParsing
      Set-Status 'Installing Ollama ...'
      Invoke-Step $exe '/VERYSILENT /NORESTART' | Out-Null
      Update-Path
    }
    if (-not (Find-Ollama)) { throw 'Ollama could not be installed. Install it from ollama.com, then start this setup again.' }
  }
  if (-not (Find-Node)) {
    if (-not $Winget) { throw 'Node.js is missing and winget is not available. Install Node.js from nodejs.org, then start this setup again.' }
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js' | Out-Null
    if (-not (Find-Node)) { throw 'Node.js could not be installed. Install it from nodejs.org, then start this setup again.' }
  }
  Show-Found

  Get-Source $target
  $app = Join-Path $target 'app'
  $npm = Find-Npm
  if (-not $npm) { throw 'npm was not found next to Node.js.' }
  Set-Status 'Installing the app''s packages (downloads Electron, a few minutes) ...'
  if ((Invoke-Step $npm 'ci --no-audit --no-fund' $app) -ne 0) {
    if ((Invoke-Step $npm 'install --no-audit --no-fund' $app) -ne 0) { throw 'npm could not install the packages. See the log above.' }
  }
  Set-Status 'Building LocalClaude.exe ...'
  if ((Invoke-Step 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$app\scripts\make-exe.ps1`"" $app) -ne 0) { throw 'Building the app failed. Is Local Claude running from this folder? Close it and try again.' }
  $script:exe = Join-Path $app 'dist\LocalClaude\LocalClaude.exe'
  if (-not (Test-Path $script:exe)) { throw 'LocalClaude.exe was not built.' }

  if ($cbTerminal.Checked) {
    Set-Status 'Installing Claude Code for the terminal launcher ...'
    if ((Invoke-Step $npm 'install -g @anthropic-ai/claude-code --no-audit --no-fund') -ne 0) { Write-Log 'Claude Code could not be installed. The chat app does not need it; the terminal launcher does.' }
  }
  if ($cbStart.Checked) { New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Local Claude.lnk') $script:exe }
  if ($cbDesk.Checked) { New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Local Claude.lnk') $script:exe }
  Set-Status 'The app is installed. Checking the hardware ...'
}

# ---------------------------------------------------------------- step 2

function Format-GB([double]$mb) {
  $v = $mb / 1024
  if ($v -ge 10 -or [Math]::Abs($v - [Math]::Round($v)) -lt 0.05) { return ('{0} GB' -f [Math]::Round($v)) }
  return ($v.ToString('0.0', [Globalization.CultureInfo]::InvariantCulture) + ' GB')
}
function Describe($c) {
  if ($c.where -eq 'gpu') { $w = 'fits on the graphics card' }
  elseif ($c.where -eq 'split') { $w = 'partly in RAM, slower' }
  else { $w = 'runs on the CPU' }
  if ($c.installed) { $i = 'installed' } else { $i = 'download' }
  return ('{0}   |   {1}, {2}, {3}' -f $c.base, (Format-GB $c.sizeMb), $w, $i)
}

function Get-Plan([string]$target) {
  $node = Find-Node
  $cli = Join-Path $target 'app\scripts\setup-cli.js'
  $file = [IO.Path]::GetTempFileName()
  $code = Invoke-Step $node "`"$cli`" plan --out `"$file`"" (Join-Path $target 'app')
  if ($code -ne 0) { throw 'The hardware check failed. See the log above.' }
  $plan = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  return $plan
}

$script:choices = @{}
function Update-Total {
  if (-not $script:plan) { return }
  $names = @{}
  $mb = 0
  foreach ($id in @('quick', 'smart', 'coder')) {
    $list = $script:choices[$id]
    if (-not $list -or $combos[$id].SelectedIndex -lt 0) { continue }   # the lists are still being filled
    $c = $list[$combos[$id].SelectedIndex]
    if ($c -and -not $c.installed -and -not $names.ContainsKey($c.base.ToLower())) { $names[$c.base.ToLower()] = $true; $mb += $c.sizeMb }
  }
  if ($cb30.Checked) { $mb += $script:plan.coder30.sizeMb }
  if ($mb -gt 0) { $total2.Text = 'To download: ' + (Format-GB $mb); $dlBtn.Text = 'Download' }
  else { $total2.Text = 'Nothing to download.'; $dlBtn.Text = 'Finish' }
  $free = $script:plan.hw.disk.freeMb
  if ($free -and $mb -gt ($free - 2048)) { $total2.Text += '  (more than the free disk space)'; $total2.ForeColor = 'Firebrick' } else { $total2.ForeColor = $form.ForeColor }
  $engBox.Enabled = $cb30.Checked; $modBox.Enabled = $cb30.Checked; $engBtn.Enabled = $cb30.Checked; $modBtn.Enabled = $cb30.Checked
}

function Show-Plan($plan, [string]$target) {
  $script:plan = $plan
  $hw = $plan.hw
  if ($hw.gpu) { $card = ('{0} ({1})' -f $hw.gpu.name, (Format-GB $hw.gpu.vramMb)) } else { $card = 'none with its own memory' }
  if ($hw.gpu -and -not $plan.card) { $card += ', too little for the models' }
  $hwLine1.Text = ('Graphics card: {0}     RAM: {1}' -f $card, (Format-GB $hw.ramMb))
  if ($hw.disk.freeMb) { $disk = (Format-GB $hw.disk.freeMb) + ' free for models' } else { $disk = 'free space unknown' }
  $hwLine2.Text = ('Processor: {0}, {1} threads     Disk: {2}' -f $hw.cpu.name, $hw.cpu.cores, $disk)
  foreach ($id in @('quick', 'smart', 'coder')) {
    $m = $plan.modes.$id
    $list = @($m.choices | Where-Object { -not $_.tooBig })
    if (-not $list.Count) { $list = @($m.choices | Select-Object -Last 1) }
    $script:choices[$id] = $list
    $combos[$id].Items.Clear()
    $sel = 0
    for ($i = 0; $i -lt $list.Count; $i++) {
      $text = Describe $list[$i]
      if ($list[$i].base -ieq $m.pick.base) { $text += '   (recommended)'; $sel = $i }
      [void]$combos[$id].Items.Add($text)
    }
    $combos[$id].SelectedIndex = $sel
  }
  $n = @($plan.notes) -join ' '
  if ($hw.gpu -and $plan.card -and $hw.gpu.vendor -and $hw.gpu.vendor -ne 'nvidia') { $n += ' Only tested with NVIDIA cards: whether Ollama uses this card is up to Ollama.' }
  $notes2.Text = $n
  if ($plan.coder30.engine) { $engBox.Text = $plan.coder30.engine } else { $engBox.Text = Join-Path $target 'colibri' }
  if ($plan.coder30.modelDir) { $modBox.Text = Split-Path $plan.coder30.modelDir } else { $modBox.Text = Join-Path $target 'colibri-models' }
  Update-Total
  $p1.Visible = $false
  $p2.Visible = $true
}
foreach ($id in @('quick', 'smart', 'coder')) { $combos[$id].Add_SelectedIndexChanged({ Update-Total }) }
$cb30.Add_CheckedChanged({ Update-Total })

function Step-Two {
  $target = $script:target
  $node = Find-Node
  $cli = Join-Path $target 'app\scripts\setup-cli.js'
  $picks = @{}
  foreach ($id in @('quick', 'smart', 'coder')) {
    $c = $script:choices[$id][$combos[$id].SelectedIndex]
    $picks[$id] = @{ base = $c.base; ctx = $c.ctx }
  }
  $file = Join-Path $env:TEMP 'local-claude-picks.json'
  [IO.File]::WriteAllText($file, ($picks | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  $ok = $true
  if ((Invoke-Step $node "`"$cli`" apply --picks `"$file`"" (Join-Path $target 'app')) -ne 0) { $ok = $false }
  Remove-Item $file -Force -ErrorAction SilentlyContinue

  if ($cb30.Checked) {
    if (-not (Find-Python)) {
      if ($Winget) { Install-WithWinget 'Python.Python.3.12' 'Python (for the colibri engine)' | Out-Null }
      if (-not (Find-Python)) { Write-Log 'Python could not be installed, so Coder 30B was skipped. Install Python 3 and run this setup again to add it.'; $ok = $false }
    }
    if (Find-Python) {
      if ((Invoke-Step $node "`"$cli`" coder30 --engine `"$($engBox.Text.Trim())`" --models `"$($modBox.Text.Trim())`"" (Join-Path $target 'app')) -ne 0) { $ok = $false }
    }
  }
  return $ok
}

# ---------------------------------------------------------------- buttons

function Set-Busy([bool]$on) {
  $script:busy = $on
  foreach ($c in @($goBtn, $dirBtn, $dirBox, $cbTerminal, $cbStart, $cbDesk, $skipBtn, $dlBtn, $cb30) + $combos.Values) { $c.Enabled = -not $on }
  if (-not $on) { Update-Total }
  [Windows.Forms.Application]::DoEvents()
}

function Finish([string]$text) {
  $p2.Visible = $false
  $p1.Visible = $false
  $bar.Value = 100
  Set-Status $text
  if ($script:exe -and (Test-Path $script:exe)) { $startBtn.Visible = $true }
}

$goBtn.Add_Click({
  Set-Busy $true
  try {
    Step-One
    $plan = Get-Plan $script:target
    Set-Busy $false
    Show-Plan $plan $script:target
    Set-Status 'Pick a model for each mode, or keep the recommended ones.'
  } catch {
    Set-Busy $false
    Set-Status ('Stopped: ' + $_.Exception.Message)
  }
})
$dlBtn.Add_Click({
  Set-Busy $true
  try {
    $ok = Step-Two
    Set-Busy $false
    if ($ok) { Finish 'Finished. Local Claude is ready.' }
    else { Set-Status 'Not everything worked (see the log). You can try again, or skip: the app offers the model setup again when it starts.' }
  } catch {
    Set-Busy $false
    Set-Status ('Stopped: ' + $_.Exception.Message)
  }
})
$skipBtn.Add_Click({ Finish 'Installed without downloading models. The app offers the model setup when it starts.' })
$startBtn.Add_Click({ Start-Process $script:exe; $form.Close() })
$form.Add_FormClosing({
  param($s, $e)
  if ($script:busy) {
    $r = [Windows.Forms.MessageBox]::Show($form, 'The setup is still working. Stop it?', 'Local Claude setup', 'YesNo', 'Question')
    if ($r -ne 'Yes') { $e.Cancel = $true; return }
    Stop-Running
  }
})

# ---------------------------------------------------------------- self test: nothing is installed or changed

if ($SelfTest) {
  $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point(-3000, -3000)
  $form.ShowInTaskbar = $false
  $form.Show()
  "winget: $([bool]$Winget) | ollama: $([bool](Find-Ollama)) | node: $([bool](Find-Node)) | npm: $([bool](Find-Npm)) | python: $([bool](Find-Python))"
  "step 1: $($cbOllama.Text) / $($cbNode.Text)"
  $shot = {
    param($name)
    if (-not $SelfTestPicture) { return }
    $bmp = New-Object Drawing.Bitmap($form.Width, $form.Height)
    $form.DrawToBitmap($bmp, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $bmp.Save(($SelfTestPicture -replace '\.png$', "-$name.png"), [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
  & $shot 'step1'
  # the checkout this script sits in stands in for an installed copy
  $script:target = Split-Path -Parent $PSScriptRoot
  $plan = Get-Plan $script:target
  Show-Plan $plan $script:target
  foreach ($id in @('quick', 'smart', 'coder')) { "step 2 $id ($($combos[$id].Items.Count) choices): $($combos[$id].SelectedItem)" }
  "step 2 total: $($total2.Text) | button: $($dlBtn.Text) | engine: $($engBox.Text) | models: $($modBox.Text)"
  $cb30.Checked = $true
  "with Coder 30B: $($total2.Text) | button: $($dlBtn.Text)"
  [Windows.Forms.Application]::DoEvents()
  & $shot 'step2'
  $form.Close()
  return
}

[void]$form.ShowDialog()
