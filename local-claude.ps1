# Local Claude: Claude Code driven by a local Ollama model, fully offline.
# Usage (from any project folder):
#   local-claude                           quick mode (4B model, fast)
#   local-claude --smart                   smart mode (9B, careful method, keeps notes)
#   local-claude --project pango           use the notes/memory of a named project
#   local-claude -p "question"             one-shot answer
#   local-claude --local-model <name>      any other Ollama model
#   local-claude --no-memory               skip Claude memory and own notes
# Every other argument goes straight to claude.
# (Arguments are parsed by hand: PowerShell's own parameter binding would
#  swallow claude flags like -p as abbreviations of its common parameters.)
$Model = $null
$Smart = $false
$NoMemory = $false
$Project = $null
$ClaudeArgs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        '--local-model' { $i++; $Model = $args[$i] }
        '--smart'       { $Smart = $true }
        '--project'     { $i++; $Project = $args[$i] }
        '--no-memory'   { $NoMemory = $true }
        default         { $ClaudeArgs += $args[$i] }
    }
}
if (-not $Model) { if ($Smart) { $Model = 'local-agent' } else { $Model = 'local-agent-4b' } }

$ErrorActionPreference = 'Stop'
$here       = $PSScriptRoot
$ollama     = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$api        = 'http://127.0.0.1:11434'
$claudeHome = Join-Path $env:USERPROFILE '.claude'
$projRoot   = Join-Path $claudeHome 'projects'
$notesRoot  = Join-Path $here 'notes'
$utf8       = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force $notesRoot | Out-Null

function Get-Slug([string]$p) { return ($p -replace '[^A-Za-z0-9]', '-') }
# Claude Code permission rules match Windows paths in POSIX form: C:\x\y -> //c/x/y
function Get-RulePath([string]$p) { return '//' + $p.Substring(0, 1).ToLower() + ($p.Substring(2) -replace '\\', '/') }

# --- 1. Ollama server -------------------------------------------------------
function Test-Ollama {
    try { Invoke-RestMethod -Uri "$api/api/version" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
if (-not (Test-Ollama)) {
    Write-Host 'Starting Ollama...'
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
    for ($i = 0; $i -lt 40 -and -not (Test-Ollama); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Ollama)) { throw 'Ollama did not start.' }
}

# --- 2. Model (built from a Modelfile on first run) ---------------------------
$modelfiles = @{ 'local-agent' = 'Modelfile'; 'local-agent-4b' = 'Modelfile-4b' }
$names = @((Invoke-RestMethod -Uri "$api/api/tags").models | ForEach-Object { $_.name })
if (($names -notcontains $Model) -and ($names -notcontains "${Model}:latest")) {
    if ($modelfiles.ContainsKey($Model)) {
        Write-Host "Building $Model from $($modelfiles[$Model])..."
        & $ollama create $Model -f (Join-Path $here $modelfiles[$Model])
        if ($LASTEXITCODE -ne 0) { throw "ollama create failed (is the base model pulled? see $($modelfiles[$Model]))" }
    } else {
        throw "Model '$Model' is not installed. Run: ollama pull $Model"
    }
}
# Tell Claude Code the real context window so auto-compact kicks in on time.
$ctx = 0
$show = Invoke-RestMethod -Method Post -Uri "$api/api/show" -Body (@{ model = $Model } | ConvertTo-Json) -ContentType 'application/json'
if ($show.parameters -match 'num_ctx\s+(\d+)') { $ctx = [int]$Matches[1] }
if ($ctx -le 0) {
    $ctx = 32768
    Write-Host "Model '$Model' sets no num_ctx; assuming $ctx. Build it from a Modelfile with PARAMETER num_ctx." -ForegroundColor Yellow
}

# --- 3. Which project: Claude memory folder + own notes file ------------------
# Claude Code names project folders after the path with every non-alphanumeric
# character replaced by '-'. Own notes use the same key, so they line up with
# the Claude project of the same folder.
$memDir = $null
$noteKey = $null
if (-not $NoMemory) {
    if ($Project) {
        # A named project: exact notes key, else a Claude project whose folder
        # name ends with the name (e.g. "pango" -> D--VSCode-Projects-pango).
        $want = Get-Slug $Project
        if (Test-Path (Join-Path $notesRoot "$want.md")) { $noteKey = $want }
        $match = Get-ChildItem $projRoot -Directory | Where-Object { $_.Name -like "*-$want" -or $_.Name -eq $want } | Select-Object -First 1
        if ($match) {
            if (-not $noteKey) { $noteKey = $match.Name }
            if (Test-Path (Join-Path $match.FullName 'memory\MEMORY.md')) { $memDir = Join-Path $match.FullName 'memory' }
        }
        if (-not $noteKey) { $noteKey = $want }   # new project of its own
    } else {
        $dir = (Get-Location).ProviderPath
        $cwdKey = Get-Slug $dir
        while ($dir) {
            $slug = Get-Slug $dir
            if (-not $noteKey -and (Test-Path (Join-Path $notesRoot "$slug.md"))) { $noteKey = $slug }
            $cand = Join-Path $projRoot "$slug\memory"
            if (-not $memDir -and (Test-Path (Join-Path $cand 'MEMORY.md'))) {
                $memDir = $cand
                if (-not $noteKey) { $noteKey = $slug }
            }
            if ($noteKey -and $memDir) { break }
            $parent = Split-Path $dir -Parent
            if (-not $parent -or $parent -eq $dir) { break }
            $dir = $parent
        }
        if (-not $noteKey) { $noteKey = $cwdKey }
    }
    if (-not $memDir) {
        $fallback = Join-Path $projRoot 'D--VSCode-Projects\memory'
        if (Test-Path (Join-Path $fallback 'MEMORY.md')) { $memDir = $fallback }
    }
}

$notesFile = $null
if ($noteKey) {
    $notesFile = Join-Path $notesRoot "$noteKey.md"
    if (-not (Test-Path $notesFile)) {
        $label = if ($Project) { $Project } else { (Get-Location).ProviderPath }
        $template = @(
            "# Notes: $label",
            '',
            "Folder: $((Get-Location).ProviderPath)",
            '',
            '## Status',
            '(one or two lines: what this project is and where it stands)',
            '',
            '## Done',
            '',
            '## Open (not done yet)',
            '',
            '## Needs fixing',
            '',
            '## Facts and decisions',
            '(paths, commands, hosts, settings, gotchas, choices the user made)',
            ''
        ) -join "`r`n"
        [IO.File]::WriteAllText($notesFile, $template, $utf8)
    }
}

# --- 4. System prompt addition ------------------------------------------------
$sb = New-Object System.Text.StringBuilder
function Add-Line([string]$s = '') { [void]$sb.AppendLine($s) }

Add-Line '# Running locally'
Add-Line "You are a local model ($Model) running offline on the user's Windows PC through Claude Code."
Add-Line 'Use the PowerShell tool for all commands (ssh, git, python, file listings). Use Read/Edit/Write for files and Glob/Grep to find things - never guess a path, look it up.'
Add-Line 'Work in small steps: one tool call, read the result, then decide the next. Never repeat a command that just failed without changing something. Say plainly when you are unsure or something failed.'
Add-Line "Run the user's own project scripts normally (python script.py, from the project folder). Do not add python -I there: it stops the script from importing the project's own modules."

if ($notesFile) {
    Add-Line ''
    Add-Line '# Your own notes (you keep these)'
    Add-Line "Your notes file for this project: $notesFile"
    Add-Line "All your notes files (one per project): $notesRoot"
    Add-Line 'The notes are your memory between sessions. Its current content is below. When the user mentions a project, feature or problem, first Grep your notes folder (and the Claude memory folder) for it and read what is already done, still open and needs fixing, then tell the user that state before you start.'
    Add-Line 'Update the notes file with the Edit tool whenever something worth remembering happens: a task finished (Done, with date), work left over (Open), a bug or failure you saw (Needs fixing, with the error), a fact or decision (paths, commands, hosts, gotchas, user choices). Keep entries short; rewrite or remove outdated lines instead of piling up. Keep the Folder line correct: it tells the next session where the project lives.'
    $others = Get-ChildItem $notesRoot -Filter '*.md' | Where-Object { $_.FullName -ne $notesFile }
    if ($others) {
        Add-Line 'Notes of other projects:'
        foreach ($o in $others) { Add-Line "- $($o.FullName)" }
    }
    Add-Line ''
    Add-Line '## Current notes file'
    Add-Line ([IO.File]::ReadAllText($notesFile, $utf8))
}

if ($memDir) {
    $index = [IO.File]::ReadAllText((Join-Path $memDir 'MEMORY.md'), $utf8)
    # Turn relative links into full paths so the model can Read them directly.
    $index = [regex]::Replace($index, '\]\(([^)\\/:]+\.md)\)', { param($m) '](' + (Join-Path $memDir $m.Groups[1].Value) + ')' })
    Add-Line ''
    Add-Line '# Claude memory (read-only)'
    Add-Line "Notes written by Claude in earlier sessions, folder: $memDir"
    Add-Line 'Below is its index. Each line links one note by full path. When a task touches a topic in the index, Read that note before acting. Notes describe the past, so check that files and commands they name still exist.'
    Add-Line "You can READ anything under $claudeHome but NEVER create, edit or delete anything there. Your own notes go in your notes file."
    Add-Line ''
    Add-Line $index
}

if ($Smart) {
    Add-Line ''
    Add-Line '# Smart mode: careful working method'
    Add-Line 'Speed does not matter here; being right does. Take the time to think each step through.'
    Add-Line '1. Start: read your notes and every matching Claude memory note. Tell the user briefly what is already done, open or broken for this topic.'
    Add-Line '2. Understand first: find and read the files, configs and logs involved before changing anything. Check your assumptions with a command instead of guessing.'
    Add-Line '3. Plan: for anything with more than two steps, write a short numbered plan into the Open section of your notes file, then follow it.'
    Add-Line '4. One step at a time, and check each one: after an edit, Read the changed part back; after a fix, run the code, test or command that proves it works. If a step fails, find the cause before trying again.'
    Add-Line '5. Before you say done: compare the result with what the user asked for. Name anything you could not check.'
    Add-Line '6. Always finish by updating your notes file: Done (with date), Open, Needs fixing, Facts and decisions.'
}

$tmp = Join-Path $env:TEMP 'local-claude'
New-Item -ItemType Directory -Force $tmp | Out-Null
$promptFile = Join-Path $tmp "system-append-$PID.md"
[IO.File]::WriteAllText($promptFile, $sb.ToString(), $utf8)

# Permissions: never write under ~/.claude; own notes may be edited without asking.
# (Edit rules cover every file-writing tool, including shell redirects.)
$allow = @()
if ($notesFile) { $allow += "Edit($(Get-RulePath $notesRoot)/**)" }
$settings = @{
    autoMemoryEnabled = $false
    permissions = @{
        deny  = @("Edit($(Get-RulePath $claudeHome)/**)")
        allow = $allow
    }
} | ConvertTo-Json -Depth 5
$settingsFile = Join-Path $tmp "settings-$PID.json"
[IO.File]::WriteAllText($settingsFile, $settings, $utf8)

# --- 5. Point Claude Code at Ollama -------------------------------------------
$env:ANTHROPIC_BASE_URL   = $api
$env:ANTHROPIC_AUTH_TOKEN = 'ollama'
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:ANTHROPIC_MODEL      = $Model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL   = $Model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $Model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = $Model
$env:ANTHROPIC_SMALL_FAST_MODEL     = $Model
$env:CLAUDE_CODE_SUBAGENT_MODEL     = $Model
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "$ctx"
$env:CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:DISABLE_TELEMETRY       = '1'
$env:DISABLE_ERROR_REPORTING = '1'
$env:DISABLE_AUTOUPDATER     = '1'
Remove-Item Env:CLAUDE_CODE_PLUGIN_DIRS -ErrorAction SilentlyContinue

# --safe-mode: no plugins, hooks, CLAUDE.md, skills or MCP servers (a small model
# gets lost in long tool lists), but the full built-in toolset, unlike --bare.
$claudeCmd = @('--safe-mode', '--strict-mcp-config', '--model', $Model,
    '--tools', 'PowerShell,Read,Edit,Write,Glob,Grep',
    '--append-system-prompt-file', $promptFile,
    '--settings', $settingsFile)
if ($notesFile) { $claudeCmd += @('--add-dir', $notesRoot) }
if ($memDir)    { $claudeCmd += @('--add-dir', $memDir) }
# Ask before every command/write. Auto mode would let the small local model
# judge its own commands (and that check times out on this GPU).
if ($ClaudeArgs -notcontains '--permission-mode') { $claudeCmd += @('--permission-mode', 'manual') }
if ($ClaudeArgs) { $claudeCmd += $ClaudeArgs }

$modeName = if ($Smart) { 'smart' } else { 'quick' }
Write-Host "Local Claude ($modeName): $Model, $ctx ctx" -ForegroundColor DarkCyan
if ($notesFile) { Write-Host "  notes:  $notesFile" -ForegroundColor DarkCyan }
if ($memDir)    { Write-Host "  memory: $memDir (read-only)" -ForegroundColor DarkCyan }
$ErrorActionPreference = 'Continue'   # claude's stderr warnings must not abort the script
& claude @claudeCmd
$code = $LASTEXITCODE
Remove-Item $promptFile, $settingsFile -ErrorAction SilentlyContinue
exit $code
