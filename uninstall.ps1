# Take PhoneDesk off a Windows PC: scheduled task, hooks, firewall rule, PATH entry and the program. Data stays unless purged.
#
# Usage
#   irm https://raw.githubusercontent.com/howznguyen/phonedesk/main/uninstall.ps1 | iex
#
# What goes
#   - the "PhoneDesk" scheduled task and any running agent
#   - the hooks PhoneDesk added to Claude Code and Codex (only our entries; <file>.phonedesk.bak is written first)
#   - the firewall rule PhoneDesk added (one UAC prompt, only if the rule exists)
#   - the program folder and its PATH entry
# What stays: %USERPROFILE%\.phonedesk (layout, paired phones, settings) - unless purged.
#
#   Environment variable      Effect
#   $env:PHONEDESK_PURGE=1    also delete the data folder
#   $env:PHONEDESK_YES=1      ask nothing
#   $env:PHONEDESK_DRY_RUN=1  list what would go, change nothing
#
# Test hook: PHONEDESK_INSTALL_HOME (same meaning as in setup.ps1).

# The same switches work on a saved copy (.\uninstall.ps1 -Purge); a switch OR its environment twin turns the option on.
param([switch]$Purge, [switch]$Yes, [switch]$DryRun)

function Uninstall-PhoneDesk {
  [CmdletBinding()]
  param([switch]$Purge, [switch]$Yes, [switch]$DryRun)
  $ErrorActionPreference = 'Stop'
  $repo = 'howznguyen/phonedesk'

  $utf = $false
  try { $utf = ([Console]::OutputEncoding.CodePage -eq 65001) } catch { }
  $G = if ($utf) { @{ ok = [string][char]0x2713; warn = '!'; bad = [string][char]0x2717; arrow = [string][char]0x2192 } } else { @{ ok = 'ok'; warn = '!'; bad = 'x'; arrow = '->' } }
  $useColor = -not $env:NO_COLOR
  function Put([string]$text, [string]$color) { if ($useColor -and $color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text } }
  function Say([string]$m) { Put "  $m" '' }
  function Good([string]$m) { Put "  $($G.ok) $m" 'Green' }
  function Warn([string]$m) { Put "  $($G.warn) $m" 'Yellow' }
  function Stage([int]$n, [string]$title) { Write-Host ''; Put "[$n/4] $title" 'Cyan' }
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

  $relocated = [bool]$env:PHONEDESK_INSTALL_HOME
  if ($relocated) {
    $binDir = Join-Path $env:PHONEDESK_INSTALL_HOME 'bin'
    $dataDir = Join-Path $env:PHONEDESK_INSTALL_HOME '.phonedesk'
  } else {
    $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
    $binDir = Join-Path $local 'PhoneDesk\bin'
    $dataDir = if ($env:PHONEDESK_HOME) { $env:PHONEDESK_HOME } else { Join-Path $env:USERPROFILE '.phonedesk' }
  }
  $exe = Join-Path $binDir 'phonedesk.exe'
  $childEnv = @{ PHONEDESK_HOME = $dataDir }
  if ($relocated) {
    $childEnv['PHONEDESK_WIN_DIR'] = Join-Path $env:PHONEDESK_INSTALL_HOME 'service'
    $childEnv['PHONEDESK_CLAUDE_DIR'] = if ($env:PHONEDESK_CLAUDE_DIR) { $env:PHONEDESK_CLAUDE_DIR } else { Join-Path $env:PHONEDESK_INSTALL_HOME '.claude' }
    $childEnv['PHONEDESK_CODEX_DIR'] = if ($env:PHONEDESK_CODEX_DIR) { $env:PHONEDESK_CODEX_DIR } else { Join-Path $env:PHONEDESK_INSTALL_HOME '.codex' }
  }
  function Run-Bin([string[]]$arguments) {
    $saved = @{}
    foreach ($k in $childEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $childEnv[$k], 'Process') }
    $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $null = & $exe @arguments 2>&1; return $LASTEXITCODE } finally { $ErrorActionPreference = $ea; foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }
  }

  # ------------------------------------------------------------ the plan
  Write-Host ''
  Put '  PhoneDesk  uninstaller for Windows' 'Cyan'
  Write-Host ''
  Say 'This will remove:'
  Say "  - the scheduled task and the program ($exe)"
  Say '  - PhoneDesk hooks in Claude Code / Codex (a backup is written first)'
  Say '  - the firewall rule PhoneDesk added, if any (Windows asks permission)'
  Say '  - the PhoneDesk entry in your PATH'
  if ($Purge) { Say "  - ALL your data in $dataDir (layout, paired phones, icons, sounds)" } else { Say "  Your data in $dataDir stays." }
  if ($DryRun) { Warn 'dry run: nothing was removed'; return }
  if (-not (Ask 'Continue?' $true)) { Say 'Cancelled. Nothing was removed.'; return }

  # ------------------------------------------------------------ 1 service and hooks
  Stage 1 'Stopping PhoneDesk and removing hooks'
  if (Test-Path -LiteralPath $exe) {
    [void](Run-Bin @('service', 'uninstall'))
    Good 'scheduled task removed'
    [void](Run-Bin @('hooks', 'remove'))
    Good 'hooks removed'
  } else {
    Warn "no program at $exe (already removed?)"
  }
  Get-Process -Name phonedesk -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700

  # ------------------------------------------------------------ 2 firewall
  Stage 2 'Firewall rule'
  $rule = $false
  try { $rule = [bool](Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' }) } catch { }
  if ($rule) {
    try {
      $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "netsh advfirewall firewall delete rule name=all program=`"$exe`"") -Verb RunAs -Wait -PassThru -WindowStyle Hidden
      if ($p.ExitCode -eq 0) { Good 'firewall rule removed' } else { Warn "netsh returned $($p.ExitCode); delete the rule named PhoneDesk in Windows Security > Firewall > Advanced settings" }
    } catch { Warn 'the permission prompt was declined; the rule named PhoneDesk is still there (Windows Security > Firewall > Advanced settings)' }
  } else {
    Say 'no PhoneDesk firewall rule found'
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
  Put "  $($G.ok) PhoneDesk is gone." 'Green'
}

if ($env:PHONEDESK_SETUP_NORUN -ne '1') {
  Uninstall-PhoneDesk -Purge:($Purge.IsPresent -or $env:PHONEDESK_PURGE -eq '1') -Yes:($Yes.IsPresent -or $env:PHONEDESK_YES -eq '1') -DryRun:($DryRun.IsPresent -or $env:PHONEDESK_DRY_RUN -eq '1')
}
