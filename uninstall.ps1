# Take Nookdeck off a Windows PC: scheduled task, hooks, firewall rule, PATH entry and the program. Data stays unless purged.
#
# Usage
#   irm https://raw.githubusercontent.com/howznguyen/nookdeck/main/uninstall.ps1 | iex
#
# What goes
#   - the "Nookdeck" scheduled task and any running agent
#   - the hooks Nookdeck added to Claude Code and Codex (only our entries; <file>.nookdeck.bak is written first)
#   - the firewall rule Nookdeck added (one UAC prompt, only if the rule exists)
#   - the program folder and its PATH entry
# What stays: %USERPROFILE%\.nookdeck (layout, paired phones, settings) - unless purged.
#
#   Environment variable      Effect
#   $env:NOOKDECK_PURGE=1    also delete the data folder
#   $env:NOOKDECK_YES=1      ask nothing
#   $env:NOOKDECK_DRY_RUN=1  list what would go, change nothing
#   $env:NOOKDECK_NO_ANALYTICS=1  send no anonymous "uninstalled" count (DO_NOT_TRACK=1 does the same)
#
# Test hook: NOOKDECK_INSTALL_HOME (same meaning as in setup.ps1).

# The same switches work on a saved copy (.\uninstall.ps1 -Purge); a switch OR its environment twin turns the option on.
param([switch]$Purge, [switch]$Yes, [switch]$DryRun, [switch]$NoAnalytics)

function Uninstall-Nookdeck {
  [CmdletBinding()]
  param([switch]$Purge, [switch]$Yes, [switch]$DryRun, [switch]$NoAnalytics)
  $ErrorActionPreference = 'Stop'
  $repo = 'howznguyen/nookdeck'

  $utf = $false
  try { $utf = ([Console]::OutputEncoding.CodePage -eq 65001) } catch { }
  $G = if ($utf) { @{ ok = [string][char]0x2713; warn = '!'; bad = [string][char]0x2717; arrow = [string][char]0x2192 } } else { @{ ok = 'ok'; warn = '!'; bad = 'x'; arrow = '->' } }
  $useColor = -not $env:NO_COLOR
  function Put([string]$text, [string]$color) { if ($useColor -and $color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text } }
  function Say([string]$m) { Put "  $m" '' }
  function Good([string]$m) { Put "  $($G.ok) $m" 'Green' }
  function Warn([string]$m) { Put "  $($G.warn) $m" 'Yellow' }
  function Stage([int]$n, [string]$title) { Write-Host ''; Put "[$n/4] $title" 'Cyan' }

  # Anonymous count: the machine kind (os, Windows build, arch) and that it was uninstalled. Never a host name, user name, path, IP or token.
  # Off with -NoAnalytics, NOOKDECK_NO_ANALYTICS=1 or DO_NOT_TRACK=1, for a dry run, a local test (INSTALL_HOME) and the test suite.
  # Fire and forget: a hidden process, 3 seconds at most, every error swallowed.
  $analyticsUrl = if ($env:NOOKDECK_ANALYTICS_URL) { $env:NOOKDECK_ANALYTICS_URL } else { 'https://nookdeck.app/api/event' }
  $analytics = (-not $NoAnalytics) -and (-not $DryRun) -and ($env:NOOKDECK_NO_ANALYTICS -ne '1') -and ($env:DO_NOT_TRACK -ne '1') -and (
    [bool]$env:NOOKDECK_ANALYTICS_URL -or (-not $env:NOOKDECK_INSTALL_HOME -and -not $env:NOOKDECK_TEST_SANDBOX))
  function Track-Uninstalled {
    $Sync = $true
    if (-not $analytics) { return }
    try {
      $ver = [Environment]::OSVersion.Version
      $clean = { param($v) $c = ([string]$v -replace '[^A-Za-z0-9_ .,:+()/-]', ''); if ($c.Length -gt 64) { $c = $c.Substring(0, 64) }; $c }
      $body = [ordered]@{ name = 'uninstall_finished'; os = 'windows'; os_version = (& $clean "$($ver.Major).$($ver.Minor).$($ver.Build)"); arch = 'x64'; installer = 'uninstall.ps1' }
      $json = ($body | ConvertTo-Json -Compress)
      if ($Sync) {
        # the last event waits (2 s at most): a closing session would kill a background process
        Invoke-RestMethod -Uri $analyticsUrl -Method Post -ContentType 'application/json' -Body $json -TimeoutSec 2 | Out-Null
      } else {
        $env:NOOKDECK_A_BODY = $json
        $cmd = 'try { Invoke-RestMethod -Uri ''' + ($analyticsUrl -replace "'", '') + ''' -Method Post -ContentType ''application/json'' -Body $env:NOOKDECK_A_BODY -TimeoutSec 3 | Out-Null } catch { }'
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ('"' + $cmd + '"')) | Out-Null
      }
    } catch { } finally { Remove-Item Env:NOOKDECK_A_BODY -ErrorAction SilentlyContinue }
  }
  function Ask([string]$question, [bool]$default) {
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    if ($Yes -or -not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { Say "$question $hint $($G.arrow) $(if ($default) { 'yes' } else { 'no' }) (default)"; return $default }
    while ($true) {
      $a = (Read-Host "  $question $hint").Trim()
      if ($a -eq '') { return $default }
      if ($a -match '^(y|yes)$') { return $true }
      if ($a -match '^(n|no)$') { return $false }
    }
  }

  $relocated = [bool]$env:NOOKDECK_INSTALL_HOME
  if ($relocated) {
    $binDir = Join-Path $env:NOOKDECK_INSTALL_HOME 'bin'
    $dataDir = Join-Path $env:NOOKDECK_INSTALL_HOME '.nookdeck'
  } else {
    $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
    $binDir = Join-Path $local 'Nookdeck\bin'
    $dataDir = if ($env:NOOKDECK_HOME) { $env:NOOKDECK_HOME } else { Join-Path $env:USERPROFILE '.nookdeck' }
  }
  $exe = Join-Path $binDir 'nookdeck.exe'
  $childEnv = @{ NOOKDECK_HOME = $dataDir }
  if ($relocated) {
    $childEnv['NOOKDECK_WIN_DIR'] = Join-Path $env:NOOKDECK_INSTALL_HOME 'service'
    $childEnv['NOOKDECK_CLAUDE_DIR'] = if ($env:NOOKDECK_CLAUDE_DIR) { $env:NOOKDECK_CLAUDE_DIR } else { Join-Path $env:NOOKDECK_INSTALL_HOME '.claude' }
    $childEnv['NOOKDECK_CODEX_DIR'] = if ($env:NOOKDECK_CODEX_DIR) { $env:NOOKDECK_CODEX_DIR } else { Join-Path $env:NOOKDECK_INSTALL_HOME '.codex' }
  }
  function Run-Bin([string[]]$arguments) {
    $saved = @{}
    foreach ($k in $childEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $childEnv[$k], 'Process') }
    $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $null = & $exe @arguments 2>&1; return $LASTEXITCODE } finally { $ErrorActionPreference = $ea; foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }
  }

  # ------------------------------------------------------------ the plan
  Write-Host ''
  Put '  Nookdeck  uninstaller for Windows' 'Cyan'
  if ($analytics) { Say 'Sends an anonymous uninstall count to nookdeck.app (opt out: NOOKDECK_NO_ANALYTICS=1)' }
  Write-Host ''
  Say 'This will remove:'
  Say "  - the scheduled task and the program ($exe)"
  Say '  - Nookdeck hooks in Claude Code / Codex (a backup is written first)'
  Say '  - the firewall rule Nookdeck added, if any (Windows asks permission)'
  Say '  - the Nookdeck entry in your PATH'
  if ($Purge) { Say "  - ALL your data in $dataDir (layout, paired phones, icons, sounds)" } else { Say "  Your data in $dataDir stays." }
  if ($DryRun) { Warn 'dry run: nothing was removed'; return }
  if (-not (Ask 'Continue?' $true)) { Say 'Cancelled. Nothing was removed.'; return }

  # ------------------------------------------------------------ 1 service and hooks
  Stage 1 'Stopping Nookdeck and removing hooks'
  if (Test-Path -LiteralPath $exe) {
    [void](Run-Bin @('service', 'uninstall'))
    Good 'scheduled task removed'
    [void](Run-Bin @('hooks', 'remove'))
    Good 'hooks removed'
  } else {
    Warn "no program at $exe (already removed?)"
  }
  Get-Process -Name nookdeck -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700

  # ------------------------------------------------------------ 2 firewall
  Stage 2 'Firewall rule'
  $rule = $false
  try { $rule = [bool](Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' }) } catch { }
  if ($rule) {
    try {
      $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "netsh advfirewall firewall delete rule name=all program=`"$exe`"") -Verb RunAs -Wait -PassThru -WindowStyle Hidden
      if ($p.ExitCode -eq 0) { Good 'firewall rule removed' } else { Warn "netsh returned $($p.ExitCode); delete the rule named Nookdeck in Windows Security > Firewall > Advanced settings" }
    } catch { Warn 'the permission prompt was declined; the rule named Nookdeck is still there (Windows Security > Firewall > Advanced settings)' }
  } else {
    Say 'no Nookdeck firewall rule found'
  }

  # ------------------------------------------------------------ 3 files and PATH
  Stage 3 'Deleting the program'
  if (Test-Path -LiteralPath $binDir) { Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue; Good "removed $binDir" }
  if (-not $relocated) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -contains $binDir) { [Environment]::SetEnvironmentVariable('Path', (($parts | Where-Object { $_ -ne $binDir }) -join ';'), 'User'); Good 'removed from your PATH' }
    $parent = Split-Path $binDir -Parent
    if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) { Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue }
  }

  # ------------------------------------------------------------ 4 data
  Stage 4 'Your data'
  if ($Purge) {
    if (Ask "Really delete $dataDir? This cannot be undone." $Yes.IsPresent) { Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue; Good "deleted $dataDir" }
  } else {
    Say "Still in $dataDir. Delete that folder to remove everything."
  }
  Write-Host ''
  Put "  $($G.ok) Nookdeck is gone." 'Green'
  Track-Uninstalled
}

if ($env:NOOKDECK_SETUP_NORUN -ne '1') {
  Uninstall-Nookdeck -Purge:($Purge.IsPresent -or $env:NOOKDECK_PURGE -eq '1') -Yes:($Yes.IsPresent -or $env:NOOKDECK_YES -eq '1') -DryRun:($DryRun.IsPresent -or $env:NOOKDECK_DRY_RUN -eq '1') -NoAnalytics:($NoAnalytics.IsPresent -or $env:NOOKDECK_NO_ANALYTICS -eq '1' -or $env:DO_NOT_TRACK -eq '1')
}
