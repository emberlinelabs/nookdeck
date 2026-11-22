# Nookdeck Windows helper: one long-lived PowerShell (5.1) process. Reads one JSON request per line on stdin,
# writes one JSON reply per line on stdout: {"id":N,"ok":true,"result":...} or {"id":N,"ok":false,"error":"..."}.
# Requests only ever carry plain data (never code); every command below is fixed.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationCore

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
namespace PD {
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p);
    int GetChannelCount(out uint n);
    int SetMasterVolumeLevel(float l, ref Guid c); int SetMasterVolumeLevelScalar(float l, ref Guid c);
    int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);
    int SetChannelVolumeLevel(uint ch, float l, ref Guid c); int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid c);
    int GetChannelVolumeLevel(uint ch, out float l); int GetChannelVolumeLevelScalar(uint ch, out float l);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid c); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int s, out IntPtr d); int GetDefaultAudioEndpoint(int f, int r, out IMMDevice d); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  public static class Audio {
    // 0x80070490 (ELEMENT_NOT_FOUND) = no default playback device (a server, a CI runner, an unplugged headset)
    public static bool Available() {
      try { var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom()); IMMDevice d; return e.GetDefaultAudioEndpoint(0, 1, out d) == 0 && d != null; }
      catch { return false; }
    }
    static IAudioEndpointVolume Ep() {
      var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
      Guid g = typeof(IAudioEndpointVolume).GUID; object o;
      Marshal.ThrowExceptionForHR(d.Activate(ref g, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }
    public static float GetLevel() { float l; Ep().GetMasterVolumeLevelScalar(out l); return l; }
    public static bool GetMute() { bool m; Ep().GetMute(out m); return m; }
    public static void SetLevel(float l) { Guid g = Guid.Empty; Ep().SetMasterVolumeLevelScalar(l, ref g); }
    public static void SetMute(bool m) { Guid g = Guid.Empty; Ep().SetMute(m, ref g); }
  }

  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public short bmPlanes, bmBitsPixel; public IntPtr bmBits; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }
  [StructLayout(LayoutKind.Sequential)] struct DIBSECTION { public BITMAP dsBm; public BITMAPINFOHEADER dsBmih; public int dsBitfields0, dsBitfields1, dsBitfields2; public IntPtr dshSection; public int dsOffset; }
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { int GetImage(SIZE size, int flags, out IntPtr phbm); }

  // Top-level windows and focus: a program started by a background process does not get the foreground by itself, and
  // SendInput goes to whatever window has it, so "open" must hand the focus to the new window before the next step types.
  public static class Win {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

    // "hwnd|pid|title" for every visible, titled, uncloaked, non-tool top-level window
    public static string[] List() {
      List<string> r = new List<string>();
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h)) return true;
        if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
        int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
        int n = GetWindowTextLength(h); if (n <= 0) return true;
        StringBuilder sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1);
        uint pid; GetWindowThreadProcessId(h, out pid);
        r.Add(h.ToInt64() + "|" + pid + "|" + sb.ToString());
        return true;
      }, IntPtr.Zero);
      return r.ToArray();
    }
    public static long Foreground() { return GetForegroundWindow().ToInt64(); }
    public static bool Focus(long hwnd) {
      IntPtr h = new IntPtr(hwnd);
      if (IsIconic(h)) ShowWindow(h, 9);
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // a pressed key lets this process take the foreground
      uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      uint me = GetCurrentThreadId();
      bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
      try { BringWindowToTop(h); SetForegroundWindow(h); } finally { if (attached) AttachThreadInput(me, fg, false); }
      return GetForegroundWindow() == h;
    }
  }
  public static class Shell {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr bc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory f);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int n, ref BITMAP b);
    [DllImport("gdi32.dll", EntryPoint = "GetObject")] static extern int GetDib(IntPtr h, int n, ref DIBSECTION d);

    // PNG bytes of the icon the shell shows for an item (an app in shell:AppsFolder, or a file path), px by px, keeping alpha.
    public static byte[] IconPng(string parsingName, int px) {
      Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
      IShellItemImageFactory f; SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref iid, out f);
      IntPtr h; SIZE s; s.cx = px; s.cy = px;
      Marshal.ThrowExceptionForHR(f.GetImage(s, 4 /* ICONONLY */ | 1 /* BIGGERSIZEOK */, out h));
      try {
        BITMAP b = new BITMAP(); GetObject(h, Marshal.SizeOf(typeof(BITMAP)), ref b);
        // The shell hands back a DIB section, normally bottom-up (positive biHeight): its first row in memory is the
        // bottom of the picture. Read it from the last row with a negative stride so the icon is not upside down.
        DIBSECTION d = new DIBSECTION();
        bool bottomUp = GetDib(h, Marshal.SizeOf(typeof(DIBSECTION)), ref d) == Marshal.SizeOf(typeof(DIBSECTION)) ? d.dsBmih.biHeight > 0 : true;
        IntPtr scan0 = bottomUp ? new IntPtr(b.bmBits.ToInt64() + (long)b.bmWidthBytes * (b.bmHeight - 1)) : b.bmBits;
        int stride = bottomUp ? -b.bmWidthBytes : b.bmWidthBytes;
        using (Bitmap src = new Bitmap(b.bmWidth, b.bmHeight, stride, PixelFormat.Format32bppArgb, scan0))
        using (Bitmap dst = new Bitmap(px, px, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(dst)) {
          g.Clear(Color.Transparent);
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          g.DrawImage(src, 0, 0, px, px);
          using (MemoryStream ms = new MemoryStream()) { dst.Save(ms, ImageFormat.Png); return ms.ToArray(); }
        }
      } finally { DeleteObject(h); }
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

# ---- WinRT (GlobalSystemMediaTransportControls) ----
$script:winrt = $false
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $script:winrt = $true
} catch { }

function Await($op, $type) {
  $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  try { if (-not $t.Wait(6000)) { throw 'timed out' } } catch [System.AggregateException] { throw $_.Exception.InnerException }
  $t.Result
}
function Get-Session {
  if (-not $script:winrt) { throw 'media session API is not available' }
  if (-not $script:mgr) { $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
  $script:mgr.GetCurrentSession()
}
$propsType = $null
if ($script:winrt) { $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties] }

function Cmd-MediaRead {
  $s = Get-Session
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
  $pb = $s.GetPlaybackInfo(); $tl = $s.GetTimelineProperties()
  $status = $pb.PlaybackStatus.ToString()
  if ($status -eq 'Closed' -or (-not $p.Title -and -not $p.Artist)) { return $null }
  $pos = $tl.Position.TotalSeconds
  if ($status -eq 'Playing') { $pos += [Math]::Max(0, ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds) }
  $dur = $tl.EndTime.TotalSeconds - $tl.StartTime.TotalSeconds
  if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
  @{ app = $s.SourceAppUserModelId; title = [string]$p.Title; artist = [string]$p.Artist; album = [string]$p.AlbumTitle
     playing = ($status -eq 'Playing'); position = [Math]::Round($pos, 1); duration = [Math]::Round([Math]::Max(0, $dur), 1) }
}

function Cmd-MediaArtwork($a) {
  $s = Get-Session
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
  if (-not $p.Thumbnail) { return $null }
  $rs = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($rs)
  $img = [System.Drawing.Image]::FromStream($stream)
  $max = [int]$a.max
  $r = [Math]::Min(1.0, $max / [double][Math]::Max($img.Width, $img.Height))
  $w = [Math]::Max(1, [int]($img.Width * $r)); $h = [Math]::Max(1, [int]($img.Height * $r))
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h); $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $img.Dispose(); $bmp.Dispose(); $stream.Dispose()
  'data:image/jpeg;base64,' + [Convert]::ToBase64String($ms.ToArray())
}

function Cmd-MediaControl($a) {
  $s = Get-Session
  if (-not $s) { return $false }
  switch ($a.op) {
    'play' { $null = Await ($s.TryPlayAsync()) ([bool]) }
    'playpause' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
    'next' { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
    'previous' { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    default { throw 'unknown media op' }
  }
  $true
}

function Cmd-VolumeGet {
  if (-not [PD.Audio]::Available()) { return $null }  # no audio device: the agent reports "unknown", never an error
  try { @{ level = [int][Math]::Round([PD.Audio]::GetLevel() * 100); muted = [PD.Audio]::GetMute() } } catch { $null }
}
function Cmd-VolumeSet($a) {
  if (-not [PD.Audio]::Available()) { throw "no audio device" }
  if ($null -ne $a.level) { [PD.Audio]::SetLevel([float]([Math]::Max(0, [Math]::Min(100, [double]$a.level)) / 100.0)) }
  if ($null -ne $a.muted) { [PD.Audio]::SetMute([bool]$a.muted) }
  $true
}

function Cmd-AppsList {
  $list = @()
  foreach ($a in (Get-StartApps)) { if ($a.Name -and $a.AppID) { $list += @{ name = [string]$a.Name; id = [string]$a.AppID } } }
  , $list
}
function Cmd-AppIcon($a) {
  $px = [int]$a.px
  [Convert]::ToBase64String([PD.Shell]::IconPng('shell:AppsFolder\' + [string]$a.appId, $px))
}
function Cmd-AppOpen($a) {
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + [string]$a.appId)
  $true
}

function Cmd-ImageResize($a) {
  $src = [Convert]::FromBase64String([string]$a.data)
  $ms = New-Object System.IO.MemoryStream (, $src)
  $img = [System.Drawing.Image]::FromStream($ms)
  $w = $img.Width; $h = $img.Height; $max = [int]$a.max
  if ([Math]::Max($w, $h) -gt $max) { $r = $max / [double][Math]::Max($w, $h); $w = [Math]::Max(1, [int]($w * $r)); $h = [Math]::Max(1, [int]($h * $r)) }
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h); $g.Dispose()
  $out = New-Object System.IO.MemoryStream
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose(); $bmp.Dispose()
  [Convert]::ToBase64String($out.ToArray())
}

function Cmd-NetCounters {
  $o = @{}
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -eq 'Up' -and $n.NetworkInterfaceType -ne 'Loopback' -and $n.NetworkInterfaceType -ne 'Tunnel') {
      $s = $n.GetIPv4Statistics()
      $o[$n.Name] = @{ rx = [double]$s.BytesReceived; tx = [double]$s.BytesSent }
    }
  }
  $o
}

# ---- GPU: utilisation from the 3D engine counters, memory from the adapter counters, NVIDIA temperature from nvidia-smi ----
$script:gpuStatic = $null
$script:gpuTemp = $null
$script:gpuTempAt = [DateTime]::MinValue
function Gpu-Static {
  # name and total VRAM of the adapter with the most memory; cached for the life of the helper
  $name = $null; $total = $null
  try {
    $best = $null
    foreach ($v in (Get-CimInstance Win32_VideoController -ErrorAction Stop)) {
      if (-not $v.Name -or $v.Name -match 'Basic|Remote|Virtual|Parsec|Mirage') { continue }
      if (-not $best -or [double]$v.AdapterRAM -gt [double]$best.AdapterRAM) { $best = $v }
    }
    if ($best) { $name = [string]$best.Name; if ($best.AdapterRAM -and [double]$best.AdapterRAM -gt 0) { $total = [double]$best.AdapterRAM } }
  } catch { }
  try {
    # Win32_VideoController.AdapterRAM is a 32-bit field (capped at 4 GB); the driver key holds the real 64-bit size
    $max = 0.0
    foreach ($k in (Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction Stop)) {
      $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
      if ($p -and $p.'HardwareInformation.qwMemorySize') { $q = [double]$p.'HardwareInformation.qwMemorySize'; if ($q -gt $max) { $max = $q } }
    }
    if ($max -gt 0) { $total = $max }
  } catch { }
  @{ name = $name; total = $total }
}
function Cmd-GpuRead {
  # one counter call for every engine type; the helper only returns the non-zero samples (the busiest adapter is worked out in
  # src/platform/win32/gpu.ts: per adapter and engine type the instances add up, then the max over engine types, like Task Manager)
  $engines = $null; $used = $null
  try {
    $engines = @()
    foreach ($s in (Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples) {
      if ([double]$s.CookedValue -gt 0) { $engines += , @([string]$s.InstanceName, [double]$s.CookedValue) }
    }
  } catch { $engines = $null }
  if ($null -eq $engines) { return $null }
  try {
    $m = (Get-Counter -Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples
    $bm = @{}
    foreach ($s in $m) { $luid = if ($s.InstanceName -match 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)') { $Matches[1] } else { 'x' }; $bm[$luid] = [double]$bm[$luid] + [double]$s.CookedValue }
    foreach ($v in $bm.Values) { if ($null -eq $used -or $v -gt $used) { $used = $v } }
  } catch { }
  if (-not $script:gpuStatic) { $script:gpuStatic = Gpu-Static }
  $o = @{ engines = $engines }
  if ($null -ne $used) { $o['memUsed'] = $used }
  if ($script:gpuStatic.total) { $o['memTotal'] = $script:gpuStatic.total }
  if ($script:gpuStatic.name) { $o['name'] = $script:gpuStatic.name }
  if (([DateTime]::UtcNow - $script:gpuTempAt).TotalSeconds -ge 10) {
    $script:gpuTempAt = [DateTime]::UtcNow
    $script:gpuTemp = $null
    try {
      $smi = Get-Command nvidia-smi.exe -ErrorAction Stop
      $t = & $smi.Source --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1
      if ($t -match '^\s*(\d+)\s*$') { $script:gpuTemp = [int]$Matches[1] }
    } catch { }
  }
  if ($null -ne $script:gpuTemp) { $o['temp'] = $script:gpuTemp }
  $o
}

function Cmd-Processes {
  $list = @()
  foreach ($p in (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)) {
    if ($p.Name -eq '_Total' -or $p.Name -eq 'Idle') { continue }
    $list += @{ pid = [int]$p.IDProcess; name = ([string]$p.Name); cpu = [double]$p.PercentProcessorTime; mem = [double]$p.WorkingSet }
  }
  , $list
}

function Cmd-SoundDuration($a) {
  $p = New-Object System.Windows.Media.MediaPlayer
  $p.Open([Uri]([string]$a.path))
  $end = [DateTime]::UtcNow.AddSeconds(2)
  while (-not $p.NaturalDuration.HasTimeSpan -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 40 }
  $ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds } else { $null }
  $p.Close()
  $ms
}

function Win-Windows {
  $o = @()
  foreach ($l in [PD.Win]::List()) {
    $p = $l.Split('|', 3)
    $o += @{ hwnd = [int64]$p[0]; pid = [int]$p[1]; title = [string]$p[2] }
  }
  , $o
}

# After a program was started: wait for its new window (or, when it reused one, a window of the hinted process), then
# bring it to the foreground so the keys of the next macro step reach it.
function Cmd-WindowFocusNew($a) {
  $before = @{}
  foreach ($h in @($a.before)) { $before[[int64]$h] = $true }
  $hint = ([string]$a.hint).ToLowerInvariant()
  $ms = if ($a.ms) { [int]$a.ms } else { 4000 }
  $end = [DateTime]::UtcNow.AddMilliseconds($ms)
  $consoles = @('cmd', 'conhost', 'openconsole')
  $pick = $null
  $lastNew = $null # when the most recent new window appeared
  while ($true) {
    $all = Win-Windows
    $new = @($all | Where-Object { -not $before.ContainsKey($_.hwnd) })
    if ($new.Count) {
      # a splash screen or a console may come first: keep looking for a short while and prefer a real window
      if (-not $lastNew -or $new.Count -ne $script:seenNew) { $lastNew = [DateTime]::UtcNow; $script:seenNew = $new.Count }
      $real = @($new | Where-Object { $pn = ''; try { $pn = (Get-Process -Id $_.pid -ErrorAction Stop).ProcessName.ToLowerInvariant() } catch { }; $consoles -notcontains $pn })
      $cand = if ($real.Count) { $real } else { $new }
      $pick = $cand[$cand.Count - 1]
      $quiet = ([DateTime]::UtcNow - $lastNew).TotalMilliseconds
      if ($quiet -gt $(if ($real.Count) { 600 } else { 2500 })) { break }
    } elseif ($hint -and [DateTime]::UtcNow -gt $end.AddMilliseconds(-1500)) {
      foreach ($w in $all) {
        $pn = ''
        try { $pn = (Get-Process -Id $w.pid -ErrorAction Stop).ProcessName.ToLowerInvariant() } catch { }
        if ($pn -eq $hint -or $pn -eq ($hint -replace '\s', '') -or $w.title.ToLowerInvariant().Contains($hint)) { $pick = $w; break }
      }
      if ($pick) { break }
    }
    if ([DateTime]::UtcNow -gt $end) { break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $pick) { return @{ hwnd = 0; title = ''; focused = $false } }
  Start-Sleep -Milliseconds 150 # let the window finish creating itself
  $ok = [PD.Win]::Focus([int64]$pick.hwnd)
  @{ hwnd = [int64]$pick.hwnd; title = [string]$pick.title; focused = [bool]$ok }
}

function Handle($req) {
  switch ($req.cmd) {
    'ping' { return 'pong' }
    'media.read' { return Cmd-MediaRead }
    'media.artwork' { return Cmd-MediaArtwork $req }
    'media.control' { return Cmd-MediaControl $req }
    'volume.get' { return Cmd-VolumeGet }
    'volume.set' { return Cmd-VolumeSet $req }
    'apps.list' { return Cmd-AppsList }
    'apps.icon' { return Cmd-AppIcon $req }
    'apps.open' { return Cmd-AppOpen $req }
    'image.resize' { return Cmd-ImageResize $req }
    'net.counters' { return Cmd-NetCounters }
    'gpu.read' { return Cmd-GpuRead }
    'proc.list' { return Cmd-Processes }
    'window.list' { return Win-Windows }
    'window.focusnew' { return Cmd-WindowFocusNew $req }
    'window.foreground' { return [PD.Win]::Foreground() }
    'sound.duration' { return Cmd-SoundDuration $req }
    default { throw ('unknown command ' + $req.cmd) }
  }
}

function Reply($id, $ok, $res, $err) {
  $o = [ordered]@{ id = $id; ok = $ok }
  if ($ok) { $o['result'] = $res } else { $o['error'] = $err }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

Reply 0 $true 'ready' $null
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = -1
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    Reply $id $true (Handle $req) $null
  } catch {
    Reply $id $false $null ([string]$_.Exception.Message)
  }
}
