# Nookdeck for Windows 10/11 (experimental): fetch, verify, install and start it from one command.
#
# Usage
#   irm https://raw.githubusercontent.com/howznguyen/nookdeck/main/setup.ps1 | iex
#
# Run it from a normal PowerShell window. Only the optional firewall rule needs administrator rights, and Windows asks
# for those itself (UAC). Run it again any time to upgrade; %USERPROFILE%\.nookdeck is never wiped.
#
# `irm | iex` cannot take parameters, so every switch has an environment twin:
#
#   Environment variable            Effect
#   $env:NOOKDECK_YES=1            take every default, ask nothing
#   $env:NOOKDECK_VERSION=0.2.0    install that release, not the newest
#   $env:NOOKDECK_FORCE=1          reinstall even if this release is already in place
#   $env:NOOKDECK_PORT=7420        port for the agent
#   $env:NOOKDECK_NO_AUTOSTART=1   skip the sign-in scheduled task
#   $env:NOOKDECK_NO_START=1       place the program only, do not launch it
#   $env:NOOKDECK_NO_OPEN=1        do not open the manage page afterwards
#   $env:NOOKDECK_NO_FIREWALL=1    do not offer the firewall rule
#   $env:NOOKDECK_NO_PATH=1        leave PATH alone
#   $env:NOOKDECK_DRY_RUN=1        fetch and verify, say what would change, change nothing
#   $env:NOOKDECK_NO_ANALYTICS=1   send no anonymous install count (DO_NOT_TRACK=1 does the same)
#
# Prefer parameters? Save the file, set $env:NOOKDECK_SETUP_NORUN=1, dot-source it, then call
#   Install-Nookdeck -Yes -Port 7421
#
# Test hooks (not for everyday use)
#   NOOKDECK_RELEASE_BASE   folder or URL holding nookdeck-windows-x64.exe and SHA256SUMS
#   NOOKDECK_INSTALL_HOME   install below this folder instead of %LOCALAPPDATA% / %USERPROFILE%
#   NOOKDECK_GITHUB_URL / NOOKDECK_API_URL   point the "newest release" lookup at a local server
#   NOOKDECK_RETRY_SECONDS  scales the pause between lookup rounds

# The same switches work on a saved copy (.\setup.ps1 -NoOpen -Port 7421); a switch OR its environment twin turns the option on.
param(
  [switch]$Yes, [string]$Version = '', [int]$Port = 0, [switch]$NoAutostart, [switch]$NoStart,
  [switch]$NoOpen, [switch]$NoFirewall, [switch]$NoPath, [switch]$DryRun, [switch]$Force, [switch]$NoAnalytics
)

function Install-Nookdeck {
  [CmdletBinding()]
  param(
    [switch]$Yes, [string]$Version = '', [int]$Port = 7420, [switch]$NoAutostart, [switch]$NoStart,
    [switch]$NoOpen, [switch]$NoFirewall, [switch]$NoPath, [switch]$DryRun, [switch]$Force, [switch]$NoAnalytics
  )
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest crawl in Windows PowerShell 5.1
  $repo = 'howznguyen/nookdeck'
  $asset = 'nookdeck-windows-x64.exe'
  $stages = 6

  # state shared between phases (a hashtable, so nested functions can change it)
  $S = @{
    tmp = $null; base = $null; tag = $null; custom = $false
    asset = $asset; legacy = $false; newVersion = $null; oldVersion = $null; upToDate = $false; dryDone = $false
    alreadyRunning = $false; svcBefore = $false; svcKeep = $false; autostart = $false
    binState = 'already set'; pathState = 'skipped'; svcState = 'skipped'; fwState = 'skipped'
    pathAdded = $false; pairing = $null; cur = 'start'; handover = $false
  }

  # ------------------------------------------------------------ terminal look
  # Glyphs only when the console really speaks UTF-8; otherwise plain ASCII. Colour unless NO_COLOR is set.
  $utf = $false
  try { $utf = ([Console]::OutputEncoding.CodePage -eq 65001) } catch { }
  $G = if ($utf) { @{ ok = [string][char]0x2713; warn = '!'; bad = [string][char]0x2717; arrow = [string][char]0x2192 } } else { @{ ok = 'ok'; warn = '!'; bad = 'x'; arrow = '->' } }
  $useColor = -not $env:NO_COLOR
  function Put([string]$text, [string]$color) {
    if ($useColor -and $color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
  }
  function Say([string]$m) { Put "  $m" '' }
  function Good([string]$m) { Put "  $($G.ok) $m" 'Green' }
  function Warn([string]$m) { Put "  $($G.warn) $m" 'Yellow' }
  # ------------------------------------------------------------ anonymous install count
  # Sends the kind of machine (os, Windows build, arch) and what happened to nookdeck.app. Never a host name, user name, path, IP, PIN or token.
  # Off with -NoAnalytics, NOOKDECK_NO_ANALYTICS=1 or DO_NOT_TRACK=1; never for a dry run, a local test (RELEASE_BASE / INSTALL_HOME) or the
  # test suite. NOOKDECK_ANALYTICS_URL points it elsewhere and overrides those skips. Fire and forget: a hidden process, 3 seconds at most,
  # every error swallowed.
  $analyticsUrl = if ($env:NOOKDECK_ANALYTICS_URL) { $env:NOOKDECK_ANALYTICS_URL } else { 'https://nookdeck.app/api/event' }
  $analytics = (-not $NoAnalytics) -and (-not $DryRun) -and ($env:NOOKDECK_NO_ANALYTICS -ne '1') -and ($env:DO_NOT_TRACK -ne '1') -and (
    [bool]$env:NOOKDECK_ANALYTICS_URL -or (-not $env:NOOKDECK_RELEASE_BASE -and -not $env:NOOKDECK_INSTALL_HOME -and -not $env:NOOKDECK_TEST_SANDBOX))
  function Clean-Value([string]$v) { $c = ($v -replace '[^A-Za-z0-9_ .,:+()/-]', ''); if ($c.Length -gt 64) { $c = $c.Substring(0, 64) }; return $c }
  function Reason-Code([string]$what) { # a short code for a failure message: never the message itself (it may hold a path)
    if ($what -match 'could not fetch|could not reach|latest release|GitHub') { return 'network' }
    if ($what -match 'checksum|SHA256SUMS|no entry') { return 'checksum' }
    if ($what -match 'does not run') { return 'not_runnable' }
    if ($what -match 'is taken by') { return 'port_taken' }
    if ($what -match 'cancelled') { return 'cancelled' }
    if ($what -match 'administrator|elevat') { return 'admin' }
    return 'error'
  }
  function Track([string]$name, [hashtable]$extra, [bool]$Sync = $false) {
    if (-not $analytics) { return }
    try {
      $ver = [Environment]::OSVersion.Version
      $body = [ordered]@{ name = $name; os = 'windows'; os_version = (Clean-Value "$($ver.Major).$($ver.Minor).$($ver.Build)"); arch = 'x64'; installer = 'setup.ps1' }
      if ($extra) { foreach ($k in @($extra.Keys | Sort-Object)) { $v = Clean-Value ([string]$extra[$k]); if ($v) { $body[$k] = $v } } }
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
  function Stage([int]$n, [string]$title) {
    $S.cur = @('', 'detect', 'release', 'fetch', 'install', 'service', 'start')[$n]
    Write-Host ''; Put "[$n/$stages] $title" 'Cyan' }
  function Fail([string]$what, [string]$why) {
    Track 'install_failed' @{ step = $S.cur; reason = (Reason-Code $what) } $true
    Write-Host ''
    Put "$($G.bad) $what" 'Red'
    if ($why) { Put "  $why" '' }
    Write-Host ''
    Put "  Need help? https://github.com/$repo/issues" ''
    throw "Nookdeck setup failed: $what"
  }
  function Show-Banner {
    Write-Host ''
    if ($utf) {
      $tl = [char]0x256D; $tr = [char]0x256E; $bl = [char]0x2570; $br = [char]0x256F; $h = [string][char]0x2500; $v = [char]0x2502
      Put ("  $tl" + ($h * 6) + "$tr") 'Cyan'
      Put "  $v $([char]0x25C9)  $([char]0x25AD) $v  Nookdeck" 'Cyan'
      Put ("  $bl" + ($h * 6) + "$br  installer for Windows") 'Cyan'
    } else {
      Put '  +------+' 'Cyan'
      Put '  | o  = |  Nookdeck' 'Cyan'
      Put '  +------+  installer for Windows' 'Cyan'
    }
  }
  function Ask([string]$question, [bool]$default) {
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    if ($Yes -or -not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
      Say "$question $hint $($G.arrow) $(if ($default) { 'yes' } else { 'no' }) (default)"
      return $default
    }
    while ($true) {
      $a = (Read-Host "  $question $hint").Trim()
      if ($a -eq '') { return $default }
      if ($a -match '^(y|yes)$') { return $true }
      if ($a -match '^(n|no)$') { return $false }
    }
  }

  try {
    # Windows PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    if ($Port -lt 1 -or $Port -gt 65535) { Fail '-Port must be between 1 and 65535' '' }

    # ------------------------------------------------------------ where everything lives
    $relocated = [bool]$env:NOOKDECK_INSTALL_HOME
    if ($relocated) {
      $installHome = $env:NOOKDECK_INSTALL_HOME
      $binDir = Join-Path $installHome 'bin'
      $dataDir = Join-Path $installHome '.nookdeck'
      $svcDir = Join-Path $installHome 'service'
    } else {
      $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
      $binDir = Join-Path $local 'Nookdeck\bin'
      $dataDir = Join-Path $env:USERPROFILE '.nookdeck'
      $svcDir = Join-Path $local 'Nookdeck'
    }
    $exe = Join-Path $binDir 'nookdeck.exe'
    $releaseFile = Join-Path $binDir '.release'
    $launcher = Join-Path $svcDir 'launch.vbs'
    $logDir = Join-Path $dataDir 'logs'
    # A relocated install (tests) keeps every file the program touches inside it.
    $childEnv = @{ NOOKDECK_HOME = $dataDir; PHONEDESK_HOME = $dataDir } # the second one is for a 0.1.x program, which only knows the old name
    if ($relocated) {
      $childEnv['NOOKDECK_WIN_DIR'] = $svcDir
      $childEnv['NOOKDECK_CLAUDE_DIR'] = if ($env:NOOKDECK_CLAUDE_DIR) { $env:NOOKDECK_CLAUDE_DIR } else { Join-Path $installHome '.claude' }
      $childEnv['NOOKDECK_CODEX_DIR'] = if ($env:NOOKDECK_CODEX_DIR) { $env:NOOKDECK_CODEX_DIR } else { Join-Path $installHome '.codex' }
    } elseif ($env:NOOKDECK_HOME) {
      $childEnv['NOOKDECK_HOME'] = $env:NOOKDECK_HOME
    }
    function Run-Bin([string]$file, [string[]]$arguments, [switch]$Quiet) {
      # runs the program with Nookdeck's environment; returns its exit code (output shown unless -Quiet)
      $saved = @{}
      foreach ($k in $childEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $childEnv[$k], 'Process') }
      $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue' # a native program writing to stderr must not abort us
      try {
        $out = & $file @arguments 2>&1
        $code = $LASTEXITCODE
        if (-not $Quiet) { foreach ($l in $out) { Say "$l" } }
        return $code
      } finally {
        $ErrorActionPreference = $ea
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
      }
    }
    function Sha([string]$f) { return (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant() }
    function VerOf([string]$line) { if ($line -match '^(?:nookdeck|phonedesk) (\S+)') { return $Matches[1] }; return '' }
    function Version-Line([string]$file) {
      $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { return (& $file --version 2>$null | Select-Object -First 1) } catch { return $null } finally { $ErrorActionPreference = $ea }
    }
    function Agent-Line([int]$p) { # what the agent on a port says about itself, $null when silent
      try {
        $ab = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/about" -Headers @{ 'x-nookdeck' = '1' } -TimeoutSec 2
        $line = "nookdeck $($ab.version)"
        if ($ab.commit) { $line += " ($($ab.commit)$(if ($ab.dirty) { '-dirty' }))" }
        return $line
      } catch { return $null }
    }

    # ============================================================ phase 1: detect platform
    function Detect-Platform {
      Stage 1 'Checking this PC'
      if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { Fail "this installer only runs on Windows" '' }
      if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Nookdeck needs 64-bit Windows 10 or 11' '' }
      $os = [Environment]::OSVersion.Version
      if ($os.Major -lt 10) { Fail "Nookdeck needs Windows 10 or 11" "This is $($os.ToString())." }
      if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $relocated) {
        # With UAC off (EnableLUA=0) every process of an administrator account is elevated and there is no normal window to
        # switch to: installing for this user is the only option, so carry on without asking.
        $uacOff = $false
        try { $uacOff = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop).EnableLUA -eq 0 } catch { }
        if ($uacOff) {
          Say 'UAC is off on this PC, so PowerShell always runs elevated; installing for this user.'
        } else {
          Warn 'This window is elevated. Nookdeck should run as your own user; a normal PowerShell window is better.'
          if (-not (Ask 'Continue anyway?' $false)) { Fail 'cancelled' 'Nothing was installed.' }
        }
      }
      Good "Windows $($os.Major).$($os.Build) x64 $($G.arrow) $asset"
    }

    # ============================================================ phase 2: resolve release
    function Resolve-Release {
      Stage 2 'Finding the release'
      $S.tmp = Join-Path ([IO.Path]::GetTempPath()) ('nookdeck-setup-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
      New-Item -ItemType Directory -Path $S.tmp | Out-Null
      if ($env:NOOKDECK_RELEASE_BASE) {
        $S.base = $env:NOOKDECK_RELEASE_BASE.TrimEnd('/', '\')
        $S.custom = $true
        Good "using NOOKDECK_RELEASE_BASE ($($S.base))"
        return
      }
      $ghUrl = if ($env:NOOKDECK_GITHUB_URL) { $env:NOOKDECK_GITHUB_URL.TrimEnd('/') } else { 'https://github.com' }
      if ($env:NOOKDECK_GITHUB_URL) { $S.custom = $true }
      if ($Version) {
        $S.tag = 'v' + $Version.TrimStart('v')
      } else {
        # GitHub answers 5xx now and then: redirect lookup, then the API, 4 rounds with a growing pause.
        $apiUrl = if ($env:NOOKDECK_API_URL) { $env:NOOKDECK_API_URL.TrimEnd('/') } else { 'https://api.github.com' }
        $pause = if ($env:NOOKDECK_RETRY_SECONDS) { [int]$env:NOOKDECK_RETRY_SECONDS } else { 2 }
        $tag = $null; $why = ''
        for ($round = 1; $round -le 4 -and -not $tag; $round++) {
          try {
            $req = [Net.HttpWebRequest]::Create("$ghUrl/$repo/releases/latest")
            $req.Method = 'HEAD'; $req.UserAgent = 'nookdeck-setup'; $req.Timeout = 15000
            $resp = $req.GetResponse()
            $tag = ($resp.ResponseUri.AbsoluteUri -split '/tag/')[1]
            $resp.Close()
          } catch { $why = "github.com: $($_.Exception.Message)"; $tag = $null }
          if (-not $tag) {
            try {
              $rq = [Net.HttpWebRequest]::Create("$apiUrl/repos/$repo/releases/latest")
              $rq.UserAgent = 'nookdeck-setup'; $rq.Accept = 'application/vnd.github+json'; $rq.Timeout = 15000
              $rs = $rq.GetResponse()
              $sr = New-Object IO.StreamReader($rs.GetResponseStream())
              try { $tag = [string](($sr.ReadToEnd() | ConvertFrom-Json).tag_name) } finally { $sr.Dispose(); $rs.Close() }
              if (-not $tag) { $tag = $null }
            } catch { $why = "$why; api.github.com: $($_.Exception.Message)"; $tag = $null }
          }
          if (-not $tag -and $round -lt 4) { Warn "GitHub did not answer ($why); retrying..."; Start-Sleep -Seconds ($round * $pause) }
        }
        if (-not $tag) { Fail "couldn't look up the latest release of $repo" "$why - check your connection and run it again, or pin a release with `$env:NOOKDECK_VERSION='0.1.1'." }
        $S.tag = $tag
      }
      $S.base = "$ghUrl/$repo/releases/download/$($S.tag)"
      Good "using release $($S.tag)"
    }

    # ============================================================ downloading helpers
    function Fetch([string]$src, [string]$dest) {
      if ($src -match '^https?://') {
        if (-not $S.custom -and $src -notmatch '^https://') { throw 'refusing a non-https download' }
        for ($try = 1; $try -le 3; $try++) {
          try { Invoke-WebRequest -Uri $src -OutFile $dest -UseBasicParsing -UserAgent 'nookdeck-setup'; break }
          catch { if ($try -ge 3 -or $_.Exception.Message -match '404|Not Found') { throw }; Start-Sleep -Seconds 2 }
        }
      } else {
        if (-not (Test-Path -LiteralPath $src)) { throw "not found: $src" }
        Copy-Item -LiteralPath $src -Destination $dest
      }
    }
    function Sum-For([string]$name) { # the sha256 SHA256SUMS lists for a file name, $null if absent
      foreach ($line in $S.sumLines) {
        $m = [regex]::Match($line, '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$')
        if ($m.Success -and $m.Groups[2].Value -eq $name) { return $m.Groups[1].Value.ToLowerInvariant() }
      }
      return $null
    }
    function Sum-Check([string]$file, [string]$name) {
      $want = Sum-For $name
      if (-not $want) { Fail "$name has no entry in SHA256SUMS" 'Refusing to install a file that cannot be verified.' }
      $got = Sha $file
      if ($got -ne $want) { Fail "checksum mismatch for $name" "Expected $want but got $got. Nothing was installed." }
      Good "$name checksum ok ($($got.Substring(0, 16))...)"
    }
    function Size-Hint([string]$src) {
      $bytes = 0
      try {
        if ($src -match '^https?://') {
          $rq = [Net.HttpWebRequest]::Create($src); $rq.Method = 'HEAD'; $rq.UserAgent = 'nookdeck-setup'; $rq.Timeout = 15000
          $rs = $rq.GetResponse(); $bytes = $rs.ContentLength; $rs.Close()
        } elseif (Test-Path -LiteralPath $src) { $bytes = (Get-Item -LiteralPath $src).Length }
      } catch { }
      if ($bytes -gt 0) { return " ($([math]::Ceiling($bytes / 1MB)) MB)" }
      return ''
    }
    # Big files: a progress line on a terminal, quiet otherwise. When nothing arrives for 60 s the attempt is dropped and
    # resumed with a Range request, up to 5 times.
    function Fetch-Big([string]$src, [string]$dest) {
      if ($src -notmatch '^https?://') { Fetch $src $dest; return }
      if (-not $S.custom -and $src -notmatch '^https://') { throw 'refusing a non-https download' }
      $stall = if ($env:NOOKDECK_STALL_SECONDS) { [int]$env:NOOKDECK_STALL_SECONDS } else { 60 }
      $show = -not [Console]::IsOutputRedirected
      if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
      for ($try = 1; $try -le 5; $try++) {
        $have = if (Test-Path -LiteralPath $dest) { (Get-Item -LiteralPath $dest).Length } else { 0 }
        $rs = $null; $in = $null; $out = $null
        try {
          $rq = [Net.HttpWebRequest]::Create($src); $rq.UserAgent = 'nookdeck-setup'; $rq.ReadWriteTimeout = $stall * 1000; $rq.Timeout = $stall * 1000
          if ($have -gt 0) { $rq.AddRange([int64]$have) }
          $rs = $rq.GetResponse()
          $resumed = ($have -gt 0 -and [int]$rs.StatusCode -eq 206)
          $total = if ($rs.ContentLength -gt 0) { $rs.ContentLength + $(if ($resumed) { $have } else { 0 }) } else { 0 }
          $out = [IO.File]::Open($dest, $(if ($resumed) { 'Append' } else { 'Create' }), 'Write')
          $in = $rs.GetResponseStream()
          $buf = New-Object byte[] 262144
          $done = if ($resumed) { $have } else { 0 }; $last = [DateTime]::UtcNow
          while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
            $out.Write($buf, 0, $n); $done += $n
            if ($show -and ([DateTime]::UtcNow - $last).TotalMilliseconds -gt 250) {
              $last = [DateTime]::UtcNow
              $pct = if ($total -gt 0) { [int](100 * $done / $total) } else { 0 }
              Write-Host -NoNewline ("`r  {0,3}%  {1:N1} / {2:N1} MB   " -f $pct, ($done / 1MB), ($total / 1MB))
            }
          }
          if ($show) { Write-Host '' }
          return
        } catch {
          if ($show) { Write-Host '' }
          $msg = $_.Exception.Message
          if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
          if ($msg -match '404|403|Not Found') { throw }
          Warn "no data for a while or the connection dropped ($msg); resuming from where it stopped ($try/5)"
          Start-Sleep -Seconds 2
        } finally { foreach ($x in @($in, $out, $rs)) { if ($x) { try { $x.Dispose() } catch { } } } }
      }
      Say "Tip: try later, another network or a VPN, or fetch $src by hand and point NOOKDECK_RELEASE_BASE at that folder."
      throw 'download failed'
    }

    # ============================================================ phase 3: fetch binary
    $dl = $null
    function Probe-Installed {
      $asset = $S.asset
      # A previous install leaves .release holding the sha256 of the release file it came from and of the file on disk.
      # Same release sum + untouched file + it still runs = nothing to download.
      $S.oldVersion = $null
      if (Test-Path -LiteralPath $exe) { $S.oldVersion = Version-Line $exe }
      $S.upToDate = $false
      $wantRaw = Sum-For $asset
      if (-not $Force -and $S.oldVersion -and $wantRaw -and (Test-Path -LiteralPath $releaseFile)) {
        $rel = Get-Content -LiteralPath $releaseFile -Raw
        if ($rel -match '(?m)^raw=([0-9a-f]+) installed=([0-9a-f]+)' -and $Matches[1] -eq $wantRaw -and $Matches[2] -eq (Sha $exe)) { $S.upToDate = $true }
      }
    }
    function Fetch-Binary {
      $asset = $S.asset
      Stage 3 'Getting the program'
      $sums = Join-Path $S.tmp 'SHA256SUMS'
      try { Fetch "$($S.base)/SHA256SUMS" $sums } catch { Fail "could not fetch $($S.base)/SHA256SUMS" "$($_.Exception.Message) - check the release exists and that you are online." }
      $S.sumLines = @(Get-Content -LiteralPath $sums)
      # The latest release may still be a 0.1.x one (main is pushed before the new release has finished building): it lists
      # phonedesk-* only. Take the nookdeck-* name when it is there, else the old one, and install it as the nookdeck program.
      if (-not (Sum-For $asset)) {
        $old = $asset -replace '^nookdeck-', 'phonedesk-'
        if (Sum-For $old) {
          $S.asset = $old; $asset = $old; $S.legacy = $true
          Warn "this release is from before the rename ($old); installing it as nookdeck. Run: nookdeck update (once Nookdeck 0.2 is out)."
        }
      }
      Probe-Installed
      if ($S.upToDate) {
        $S.newVersion = $S.oldVersion
        Good "Nookdeck $(VerOf $S.oldVersion) is up to date (checksum verified), skipping the download"
        return
      }
      # Releases carry a gzip of the program (a third of the size); older ones only the plain .exe.
      $got = $false
      if (Sum-For "$asset.gz") {
        $gz = Join-Path $S.tmp "$asset.gz"
        Say "Fetching $asset.gz$(Size-Hint "$($S.base)/$asset.gz")"
        try {
          Fetch-Big "$($S.base)/$asset.gz" $gz
          Sum-Check $gz "$asset.gz"
          $inS = [IO.File]::OpenRead($gz); $zs = New-Object IO.Compression.GZipStream($inS, [IO.Compression.CompressionMode]::Decompress); $outS = [IO.File]::Create($dl)
          try { $zs.CopyTo($outS) } finally { $outS.Dispose(); $zs.Dispose(); $inS.Dispose() }
          Remove-Item -LiteralPath $gz -Force -ErrorAction SilentlyContinue
          $got = $true
        } catch {
          if ($_.Exception.Message -match 'checksum mismatch') { throw }
          Warn "the compressed download failed ($($_.Exception.Message)); falling back to the uncompressed program"
          Remove-Item -LiteralPath $gz, $dl -Force -ErrorAction SilentlyContinue
        }
      }
      if (-not $got) {
        Say "Fetching $asset$(Size-Hint "$($S.base)/$asset")"
        try { Fetch-Big "$($S.base)/$asset" $dl } catch { Fail "could not fetch $($S.base)/$asset" $_.Exception.Message }
      }
    }

    # ============================================================ phase 3b: verify binary
    function Verify-Binary {
      $asset = $S.asset
      if ($S.upToDate) { return }
      Sum-Check $dl $asset # always the program itself, however it arrived
      Unblock-File -LiteralPath $dl -ErrorAction SilentlyContinue # no "from the internet" mark: SmartScreen stays quiet
      $v = $null
      $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { $v = (& $dl --version 2>$null | Select-Object -First 1) } catch { }
      $ErrorActionPreference = $ea
      if (-not $v) { Fail 'the downloaded program does not run on this PC' 'It printed no version.' }
      if ($S.legacy) { $v = 'nookdeck ' + ($v -replace '^phonedesk ', '') }
      $S.newVersion = $v
      Good "$v"
    }

    # PhoneDesk 0.1.x became Nookdeck: an existing ~\.phonedesk is handed to the program's own migration (copies the data, replaces the
    # startup entry, firewall rule and PATH entry, re-points the Claude/Codex hooks). The old folder is kept. Safe to repeat.
    function Invoke-Handover {
      $oldHome = if ($relocated) { Join-Path $installHome '.phonedesk' } else { Join-Path $env:USERPROFILE '.phonedesk' }
      if (-not (Test-Path -LiteralPath $oldHome -PathType Container)) { return }
      if (Test-Path -LiteralPath $dataDir) { return }
      if ($S.legacy) {
        # a 0.1.x program has no `migrate`: copy the data here (the old folder stays) and tell it to use the new place
        Say "found an existing PhoneDesk install ($oldHome): copying its data to $dataDir"
        try { Copy-Item -LiteralPath $oldHome -Destination $dataDir -Recurse -Force -ErrorAction Stop }
        catch { Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue; Warn "could not copy $oldHome; your PhoneDesk data is untouched" }
        return
      }
      Say "found an existing PhoneDesk install ($oldHome): moving it to Nookdeck"
      Get-Process -Name phonedesk -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 700
      $S.handover = $true
      # data, hooks and alias now; the startup entry, firewall rule and PATH entry once the new program is in place (Place-Binary below)
      $code = Run-Bin $dl @('migrate', '--no-service', '--port', "$Port")
      if ($code -eq 0) { Good 'your PhoneDesk data, startup entry and hooks were moved to Nookdeck' }
      else { Warn "the migration reported a problem; your PhoneDesk data is untouched in $oldHome" }
    }
    # ============================================================ phase 4: place binary
    function Place-Binary {
      $asset = $S.asset
      Stage 4 'Installing'
      Say "program   $exe"
      Say "your data stays in $dataDir"
      if (-not $S.upToDate -and $S.oldVersion) { Say "upgrading from $($S.oldVersion)" }
      if ($DryRun) {
        Warn 'dry run: nothing was installed, started or changed'
        if (-not $NoAutostart) { Say 'would create the scheduled task "Nookdeck" (starts when you sign in)' }
        if (-not $NoFirewall) { Say 'would offer a firewall rule for nookdeck.exe, local network only (one UAC prompt)' }
        Say "would start Nookdeck on port $Port and open http://localhost:$Port/manage/"
        $S.dryDone = $true
        return
      }
      $S.svcBefore = (Test-Path -LiteralPath $launcher)
      if ($S.upToDate) { $S.binState = 'already set'; return }
      if (-not (Ask "Install Nookdeck to ${exe}?" $true)) { Fail 'cancelled' 'Nothing was installed.' }
      $S.binState = if ($S.oldVersion) { "updated ($(VerOf $S.oldVersion) -> $(VerOf $S.newVersion))" } else { 'installed' }
      Invoke-Handover
      # let go of the old file: the scheduled task first, then an agent started by hand
      if (Test-Path -LiteralPath $exe) {
        [void](Run-Bin $exe @('service', 'uninstall') -Quiet)
        Get-Process -Name nookdeck -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 700
      }
      New-Item -ItemType Directory -Force -Path $binDir, $logDir | Out-Null
      $staged = Join-Path $binDir '.nookdeck.new.exe'
      Copy-Item -LiteralPath $dl -Destination $staged -Force
      Move-Item -LiteralPath $staged -Destination $exe -Force
      "raw=$(Sum-For $asset) installed=$(Sha $exe)" | Set-Content -LiteralPath $releaseFile -Encoding ascii
      Good "installed $($S.newVersion)"
      if ($S.handover) {
        # the old startup entry, firewall rule and PATH entry are replaced by the new program's own migration (idempotent)
        if ((Run-Bin $exe @('migrate', '--port', "$Port")) -ne 0) { Warn 'the startup entry / firewall / PATH cleanup reported a problem; run: nookdeck migrate' }
      }
    }

    # ============================================================ phase 4b: link cli (PATH)
    function Link-Cli {
      if ($NoPath -or $relocated) { return }
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      $parts = @($userPath -split ';' | Where-Object { $_ })
      if ($parts -notcontains $binDir) {
        # SetEnvironmentVariable writes HKCU\Environment and broadcasts WM_SETTINGCHANGE, so new terminals see it
        [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User')
        $S.pathAdded = $true; $S.pathState = 'installed'
        Good 'nookdeck is on your PATH'
      } else { $S.pathState = 'already set'; Say 'nookdeck is already on PATH' }
      if ($env:Path -notlike "*$binDir*") { $env:Path = "$env:Path;$binDir" } # this window too
    }

    # ============================================================ phase 5: wire service (+ firewall)
    function Service-Current {
      if (-not (Test-Path -LiteralPath $launcher)) { return $false }
      $rel = if (Test-Path -LiteralPath $releaseFile) { Get-Content -LiteralPath $releaseFile -Raw } else { '' }
      if (-not ($rel -match '(?m)^svc=([0-9a-f]+)') -or $Matches[1] -ne (Sha $launcher)) { return $false }
      $txt = Get-Content -LiteralPath $launcher -Raw
      if ($Port -eq 7420) { if ($txt -match '--port') { return $false } } elseif ($txt -notmatch "--port\W+$Port\b") { return $false }
      $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { & schtasks.exe /Query /TN Nookdeck *> $null; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $ea }
    }
    function Firewall-Rule {
      if ($NoFirewall -or $NoStart) { return }
      # BEFORE the first start: a program that listens without a rule makes Windows show a popup and, unanswered, create
      # BLOCK rules that beat any allow rule.
      $has = $false; $blocked = $false
      try {
        $rules = @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })
        $has = [bool]($rules | Where-Object { $_.Action -eq 'Allow' })
        $blocked = [bool]($rules | Where-Object { $_.Action -eq 'Block' })
      } catch { }
      if ($has -and -not $blocked) { Good 'firewall already allows nookdeck.exe'; $S.fwState = 'already set'; return }
      Say 'Windows blocks incoming connections by default, so a phone on your Wi-Fi could not reach Nookdeck.'
      if ($blocked) { Warn 'There are BLOCK rules for nookdeck.exe (from an unanswered firewall popup); the same step removes them.' }
      Say 'One inbound rule for nookdeck.exe, local subnet only (any profile, nothing from the internet). Windows will ask permission (UAC).'
      if (Ask 'Add the firewall rule?' $true) {
        $rule = "netsh advfirewall firewall delete rule name=all program=`"$exe`" >nul 2>&1 & netsh advfirewall firewall add rule name=`"Nookdeck`" dir=in action=allow program=`"$exe`" profile=any remoteip=localsubnet enable=yes"
        try {
          $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $rule) -Verb RunAs -Wait -PassThru -WindowStyle Hidden
          if ($p.ExitCode -eq 0) { Good 'firewall rule added (local subnet only)'; $S.fwState = 'installed' } else { Warn "netsh returned $($p.ExitCode); run `nookdeck doctor` for what to do" }
        } catch { Warn 'the permission prompt was declined, so no rule was added. `nookdeck doctor` shows how to add it later.' }
      } else {
        Say 'Skipped. Without the rule your phone cannot connect; `nookdeck doctor` shows the command to add it later.'
      }
    }
    function Preflight-Port {
      # something else on the port would answer the health check below: stop and say who
      $holder = $null
      try { $holder = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { }
      $S.alreadyRunning = $false
      if (-not $holder) { return }
      if ($S.upToDate -and (Agent-Line $Port) -eq $S.newVersion) { $S.alreadyRunning = $true; Say "agent already running on port $Port"; return }
      $hp = $null; try { $hp = Get-Process -Id $holder.OwningProcess -ErrorAction Stop } catch { }
      $who = if ($hp) { "$($hp.ProcessName) (pid $($hp.Id)$(if ($hp.Path) { ', ' + $hp.Path }))" } else { "process $($holder.OwningProcess)" }
      # our own program (an older copy, or one the startup task started): stop it, it is started again below
      if ($hp -and $hp.Path -and ($hp.Path -ieq $exe)) {
        Say "stopping the Nookdeck agent that holds port $Port (pid $($hp.Id)), it is started again below"
        Stop-Process -Id $hp.Id -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20; $i++) {
          Start-Sleep -Milliseconds 300
          $still = $null; try { $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { }
          if (-not $still) { return }
        }
      }
      Fail "port $Port is taken by $who" "Free it with Stop-Process -Id $($holder.OwningProcess) - or install on another port with `$env:NOOKDECK_PORT=7421. The program is in place at $exe; nothing was started."
    }
    function Wire-Service {
      Stage 5 'Background service and firewall'
      Link-Cli
      $S.autostart = -not $NoAutostart
      if ($S.autostart -and $S.upToDate -and (Service-Current)) { $S.svcKeep = $true }
      elseif ($S.autostart) { if (-not (Ask 'Start Nookdeck automatically when you sign in?' $true)) { $S.autostart = $false } }
      Firewall-Rule
      if (-not $NoStart) { Preflight-Port }
      if ($S.autostart -and $S.svcKeep) {
        $S.svcState = 'already set'
        Good "service already registered (same program, port $Port), leaving it alone"
      } elseif ($S.autostart) {
        $svcArgs = @('service', 'install')
        if ($Port -ne 7420) { $svcArgs += @('--port', "$Port") }
        if ((Run-Bin $exe $svcArgs) -eq 0) {
          Good "sign-in task registered; it restarts after a crash (logs: $logDir)"
          $S.svcState = if ($S.svcBefore) { 'updated' } else { 'installed' }
          if ((Test-Path -LiteralPath $releaseFile) -and (Test-Path -LiteralPath $launcher)) {
            $keep = @(Get-Content -LiteralPath $releaseFile | Where-Object { $_ -notmatch '^svc=' })
            ($keep + "svc=$(Sha $launcher)") | Set-Content -LiteralPath $releaseFile -Encoding ascii
          }
        } else {
          Warn 'could not register the scheduled task; starting without it'
          $S.autostart = $false
        }
      } else {
        Say 'no sign-in task (skipped)'
      }
      # make sure Claude/Codex hooks that already exist point at this program
      [void](Run-Bin $exe @('hooks', 'repoint', '--port', "$Port") -Quiet)
    }

    # ============================================================ phase 6: launch
    function Launch-Agent {
      Stage 6 'Starting Nookdeck'
      if ($NoStart) { Say "not started (NOOKDECK_NO_START). Start it with: $exe"; return }
      if (-not $S.autostart -and -not $S.alreadyRunning) {
        $saved = @{}
        foreach ($k in $childEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $childEnv[$k], 'Process') }
        try {
          [void](Start-Process -FilePath $exe -ArgumentList @('--port', "$Port") -WindowStyle Hidden -WorkingDirectory $dataDir -RedirectStandardOutput (Join-Path $logDir 'agent.out.log') -RedirectStandardError (Join-Path $logDir 'agent.err.log'))
        } finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }
      }
      $pairing = $null
      for ($i = 0; $i -lt 40; $i++) {
        try { $pairing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/pairing" -Headers @{ 'x-nookdeck' = '1' } -TimeoutSec 2; break } catch { Start-Sleep -Milliseconds 500 }
      }
      if (-not $pairing) { Fail "Nookdeck did not answer on port $Port" "See $logDir\agent.err.log" }
      # the answer could come from ANOTHER process on that port: it must be the build installed a moment ago
      $seen = $null
      for ($i = 0; $i -lt 20; $i++) {
        $seen = Agent-Line $Port
        if ($seen -eq $S.newVersion) { break }
        Start-Sleep -Milliseconds 500
      }
      if ($seen -ne $S.newVersion) {
        $tail = ''; try { $tail = ((Get-Content -LiteralPath (Join-Path $logDir 'agent.err.log') -Tail 8 -ErrorAction Stop) -join [Environment]::NewLine) } catch { }
        Fail "the agent on port $Port is not the one just installed" "It reports '$seen' but we installed '$($S.newVersion)'. Another Nookdeck probably owns the port: stop it, or use another port. Last log lines ($logDir\agent.err.log):$([Environment]::NewLine)$tail"
      }
      $S.pairing = $pairing
      Good "agent is up on port $Port"
    }

    # ============================================================ summary
    function Show-Summary {
      Write-Host ''
      Put '  -- Nookdeck ----------------------' 'Cyan'
      Write-Host ('  {0,-9} {1}' -f 'Program', $S.binState)
      Write-Host ('  {0,-9} {1}' -f 'PATH', $S.pathState)
      Write-Host ('  {0,-9} {1}' -f 'Service', $S.svcState)
      Write-Host ('  {0,-9} {1}' -f 'Firewall', $S.fwState)
      if (-not $NoStart -and $S.pairing) {
        # one Phone line per address a phone could use, the default first (nookdeck pair --plain prints: mark, url, label)
        $shown = $false
        try {
          $plain = @(& $exe pair --plain --port $Port 2>$null | Where-Object { $_ -and $_ -notmatch '^PIN' })
          foreach ($ln in $plain) {
            $f = $ln -split "`t"
            if ($f.Count -lt 2) { continue }
            $label = if ($f.Count -ge 3 -and $f[2]) { " ($($f[2]))" } else { '' }
            Write-Host ('  {0,-9} {1}{2}{3}' -f $(if ($shown) { '' } else { 'Phone' }), $f[1], $label, $(if ($shown) { '' } else { ' (default)' }))
            $shown = $true
          }
        } catch { }
        if (-not $shown) { Write-Host ('  {0,-9} {1}' -f 'Phone', $S.pairing.url) }
        Write-Host ('  {0,-9} {1}' -f 'PIN', $S.pairing.pin)
        Write-Host ('  {0,-9} {1}' -f 'Manage', "http://localhost:$Port/manage/")
      }
      Put '  -----------------------------------' 'Cyan'
      if (-not $NoStart -and $S.pairing) {
        if (-not [Console]::IsOutputRedirected -and $S.pairing.url) { try { Write-Host ''; $qrUrl = $S.pairing.url; & $exe qr "$qrUrl" } catch { } }
        Say 'On a phone on the same Wi-Fi, open the Phone address and type the PIN (or scan the code).'
        if (-not $NoOpen -and -not $relocated -and -not ($S.upToDate -and $S.alreadyRunning)) {
          if (Ask 'Open the manage page now?' $true) { try { Start-Process "http://localhost:$Port/manage/" } catch { } }
        }
      }
      if ($S.pathState -eq 'installed') { Say 'New terminal windows will find nookdeck; try: nookdeck doctor   (this window already does)' }
      Say 'Permissions and firewall check, any time: nookdeck doctor'
      Say 'To upgrade, run the same command again. To remove: uninstall.ps1 (see the README).'
    }

    # ============================================================ main
    Show-Banner
    if ($analytics) { Say 'Sends an anonymous install count to nookdeck.app (opt out: NOOKDECK_NO_ANALYTICS=1)' }
    $dl = $null
    Detect-Platform
    Track 'install_started' @{}
    Resolve-Release
    $dl = Join-Path $S.tmp $asset
    Fetch-Binary
    Verify-Binary
    Place-Binary
    if ($S.dryDone) { return }
    Wire-Service
    Launch-Agent
    Show-Summary
    $mode = if ($S.handover) { 'migrated' } elseif ($S.oldVersion) { 'upgrade' } else { 'fresh' }
    Track 'install_finished' @{ mode = $mode; version = (VerOf $S.newVersion); from_version = (VerOf $S.oldVersion) } $true
  } finally {
    if ($S.tmp -and (Test-Path -LiteralPath $S.tmp)) { Remove-Item -LiteralPath $S.tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if ($env:NOOKDECK_SETUP_NORUN -ne '1') {
  $on = { param([bool]$flag, [string]$name) $flag -or ([Environment]::GetEnvironmentVariable($name) -eq '1') }
  Install-Nookdeck `
    -Yes:(& $on $Yes.IsPresent 'NOOKDECK_YES') -Version $(if ($Version) { $Version } else { [string]$env:NOOKDECK_VERSION }) `
    -Port $(if ($Port -gt 0) { $Port } elseif ($env:NOOKDECK_PORT) { [int]$env:NOOKDECK_PORT } else { 7420 }) `
    -NoAutostart:(& $on $NoAutostart.IsPresent 'NOOKDECK_NO_AUTOSTART') -NoStart:(& $on $NoStart.IsPresent 'NOOKDECK_NO_START') `
    -NoOpen:(& $on $NoOpen.IsPresent 'NOOKDECK_NO_OPEN') -NoFirewall:(& $on $NoFirewall.IsPresent 'NOOKDECK_NO_FIREWALL') `
    -NoPath:(& $on $NoPath.IsPresent 'NOOKDECK_NO_PATH') -DryRun:(& $on $DryRun.IsPresent 'NOOKDECK_DRY_RUN') -Force:(& $on $Force.IsPresent 'NOOKDECK_FORCE') `
    -NoAnalytics:((& $on $NoAnalytics.IsPresent 'NOOKDECK_NO_ANALYTICS') -or (& $on $false 'DO_NOT_TRACK'))
}
