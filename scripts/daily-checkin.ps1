param(
  # Retry accounts that already failed today. Only do this after signing them in manually -
  # a failed checkin can leave the account logged out on the site, and re-running blind
  # keeps it stuck (IDENTITY_MISMATCH on every later attempt).
  [switch]$Force,
  # Skip the sleep guard. The guard is process-scoped (it only declares that this
  # script needs the system awake) and is released when the process ends, so
  # turning it off is a preference, not a safety measure.
  [switch]$NoSleepGuard
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8  # decode UTF-8 output from node

# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses BOM-less .ps1 as ANSI,
# so non-ASCII string literals become mojibake. To add Chinese, save as "UTF-8 with BOM".

$repo    = "D:\916938\zenxbrowser"          # zenx repo path
# edge-4 (linuxdo_25672) and edge-10 (linuxdo_27030) sign in through GitHub; the site keeps
# the linuxdo_* identity, so they run through the same checkin flow as the github_* accounts.
$aliases = @("edge-1", "edge-2", "edge-3", "edge-4", "edge-5", "edge-6", "edge-7", "edge-8", "edge-9", "edge-10",
             "edge-p3", "edge-p11", "edge-p12", "edge-p13", "edge-p14",
             "edge-p15", "edge-p16", "edge-p17", "edge-p18", "edge-p19")  # all bound accounts with a verified site identity
$cli     = Join-Path $repo "src\cli.ts"
$log     = Join-Path $repo ".zenx\logs\checkin-$(Get-Date -Format yyyyMMdd).log"
New-Item (Split-Path $log) -ItemType Directory -Force | Out-Null

# Site rate limit: after ~10 logins in quick succession it starts refusing sign-in
# ("cannot log in") for a while. Each checkin performs exactly one login, so pause
# after every $loginLimit logins. Keep this conservative - the block is silent
# (clicks land, nothing happens) and only clears after roughly 10 minutes.
$loginLimit   = 10
$coolDownMin  = 11

# A failed checkin can leave the account logged out on the site. Re-running blind then
# fails again with IDENTITY_MISMATCH and never recovers, so accounts that already failed
# today are skipped until the next day (or until -Force after a manual sign-in).
$stateFile = Join-Path $repo ".zenx\logs\failed-$(Get-Date -Format yyyyMMdd).txt"
$skip = @{}
if (Test-Path $stateFile) {
  if ($Force) { Remove-Item $stateFile -Force }
  else { Get-Content $stateFile | Where-Object { $_ } | ForEach-Object { $skip[$_] = $true } }
}

function Mark-Failed {
  param([string]$Alias)
  Add-Content -Path $stateFile -Encoding UTF8 -Value $Alias
}

# Keeps the machine awake for the whole run. Process-scoped on purpose:
# SetThreadExecutionState only declares "this process needs the system", it does not
# touch the power plan and it is dropped automatically when the process ends (even on
# a crash). Never use powercfg here - that is a machine-wide change that survives an
# abnormal exit. The node side (src/power-save.ts) does the same for the other
# platforms; this copy covers the gaps between the per-account node calls, above all
# the 11-minute rate-limit cool-down, during which nothing else is running.
$sleepGuardReleased = $false
function Enable-SleepGuard {
  if ($NoSleepGuard) {
    Add-Content -Path $log -Encoding UTF8 -Value "--- sleep guard OFF (strategy=none, disabled by -NoSleepGuard)"
    return $false
  }
  try {
    Add-Type -Namespace ZenxPower -Name Api -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);' -ErrorAction Stop
    $null = [ZenxPower.Api]::SetThreadExecutionState([uint32]2147483649)  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    Add-Content -Path $log -Encoding UTF8 -Value "--- sleep guard ON (strategy=windows-execution-state, started=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"
    return $true
  } catch {
    # Degrade, never block: a machine that dozes off mid-run is bad, a run that
    # refuses to start is worse.
    Add-Content -Path $log -Encoding UTF8 -Value "--- sleep guard unavailable (strategy=none): $($_.Exception.Message); continuing without it"
    return $false
  }
}

function Disable-SleepGuard {
  if ($sleepGuardReleased) { return }
  $script:sleepGuardReleased = $true
  try {
    $null = [ZenxPower.Api]::SetThreadExecutionState([uint32]0)  # clear ES_CONTINUOUS
    Add-Content -Path $log -Encoding UTF8 -Value "--- sleep guard OFF (released=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"
  } catch {
    Add-Content -Path $log -Encoding UTF8 -Value "--- sleep guard release failed: $($_.Exception.Message)"
  }
}

function Invoke-Zenx {
  param([string[]]$Arguments)
  $lines = & node $cli @Arguments --json 2>&1 | ForEach-Object { "$_" }
  $lines | Add-Content -Path $log -Encoding UTF8
  $script:LastOutput = ($lines | Out-String)   # callers may need to inspect the JSON report
  return $LASTEXITCODE
}

# Safety net: a leftover session means a leftover Agent Window on the desktop.
# checkin normally stops its own session, but a crash or timeout can skip that.
function Close-LeftoverSessions {
  $list = & bsk session list 2>&1 | Out-String
  if ($list -match "no active sessions") { return 0 }
  $ids = [regex]::Matches($list, '\b([a-z0-9]{4})\b') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  foreach ($id in $ids) {
    Add-Content -Path $log -Encoding UTF8 -Value "--- closing leftover session $id"
    & bsk session stop $id 2>&1 | Out-Null
  }
  return $ids.Count
}

# Closes the Edge windows of the given profile numbers (title "... - <n> - Microsoft Edge").
# ensure-online starts an Edge profile when it is offline; those windows stay on the
# desktop after checkin because bsk has no "close browser" command (session stop only
# closes the Agent Window). Match on the profile number so the user's own windows
# (e.g. Profile 1 with personal tabs) are never touched.
function Close-ProfileWindows {
  param([string[]]$Markers)
  if (-not $Markers -or $Markers.Count -eq 0) { return 0 }
  $src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ZenxCloser {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int Close(string marker) {
    int n = 0;
    EnumWindows(new EnumWindowsProc(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        string t = sb.ToString();
        if (t.Length > 0 && t.Contains(" - " + marker + " - ")) {
          PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);   // WM_CLOSE: graceful shutdown
          n++;
        }
      }
      return true;
    }), IntPtr.Zero);
    return n;
  }
}
'@
  $closed = 0
  try {
    Add-Type -TypeDefinition $src -ErrorAction Stop
    foreach ($m in ($Markers | Select-Object -Unique)) {
      $closed += [ZenxCloser]::Close($m)
      Add-Content -Path $log -Encoding UTF8 -Value "--- closed Edge window(s) for profile $m"
    }
  } catch {
    Add-Content -Path $log -Encoding UTF8 -Value "--- WARNING: could not close Edge windows: $($_.Exception.Message)"
  }
  return $closed
}

$failed = @()
$logins = 0
$launchedProfiles = @()   # profiles this run started; only these get --close-after (see below)
$null = Enable-SleepGuard   # keep the machine awake until the run finishes (see Disable-SleepGuard)
for ($i = 0; $i -lt $aliases.Count; $i++) {
  $alias = $aliases[$i]
  Add-Content -Path $log -Encoding UTF8 -Value "`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $alias ====="

  if ($skip.ContainsKey($alias)) {
    Add-Content -Path $log -Encoding UTF8 -Value "--- skipped: failed earlier today; sign in manually then rerun with -Force"
    $failed += "${alias}(skipped)"
    continue
  }

  $ensure = Invoke-Zenx @("accounts", "ensure-online", $alias)  # launch Edge profile if offline
  # Not marked failed: checkin never ran, so the account state is untouched and a
  # later retry is safe (an offline Edge profile is often just slow to start).
  if (0 -ne $ensure) { $failed += "${alias}(offline)"; continue }

  # Only profiles THIS run started get closed afterwards. An Edge the user already
  # had open shares the same profile, and --close-after would quit it - tabs and
  # unsaved work included. Leaving those alone is the whole point of the check.
  $launchedHere = $script:LastOutput -match '"launched":\s*true'
  if ($launchedHere) { $launchedProfiles += $alias }

  # No window fiddling before checkin: zenx probes the page itself and switches to
  # in-page DOM calls when the window is hidden (locked screen / no interactive desktop).

  # Pause before the login that would exceed the site's burst limit.
  # Skip the wait when no later account will log in anyway: the cool-down only
  # protects the site's login quota, so waiting with nothing behind us is pointless
  # (this is the normal case on the last account of the run, and also when every
  # remaining account is being skipped as already-failed today).
  if ($logins -gt 0 -and $logins % $loginLimit -eq 0) {
    $remaining = 0
    if ($i + 1 -lt $aliases.Count) {
      $remaining = @($aliases[($i + 1)..($aliases.Count - 1)] | Where-Object { -not $skip.ContainsKey($_) }).Count
    }
    if ($remaining -gt 0) {
      $coolStart = Get-Date
      $coolEnd   = $coolStart.AddMinutes($coolDownMin)
      $stamp = 'yyyy-MM-dd HH:mm:ss'
      Add-Content -Path $log -Encoding UTF8 -Value "--- login limit reached ($logins logins) at $($coolStart.ToString($stamp)); cooling down $coolDownMin min until $($coolEnd.ToString($stamp)) ($remaining account(s) still to sign in)"
      Start-Sleep -Seconds ($coolDownMin * 60)
      Add-Content -Path $log -Encoding UTF8 -Value "--- cool-down ended at $((Get-Date).ToString($stamp)) (waited $coolDownMin min)"
    } else {
      Add-Content -Path $log -Encoding UTF8 -Value "--- login limit reached ($logins logins) but no account after this one will log in; skipping cool-down"
    }
  }

  # Not every failure means the account got logged out (e.g. CHECKIN_UNCONFIRMED completes
  # the whole flow). But every one of them still produced a login attempt, so be
  # conservative: mark it and require a manual sign-in before retrying the same day.
  $checkinArgs = @("accounts", "checkin", $alias)
  if ($launchedHere) {
    # Quit the whole browser instance afterwards, not just the session window:
    # a dozen lingering Edge processes is the biggest memory cost of the run.
    $checkinArgs = @("accounts", "checkin", $alias, "--close-after")
  }
  if (0 -ne (Invoke-Zenx $checkinArgs)) { $failed += $alias; Mark-Failed $alias }
  $logins++
}

# Daily snapshot: record each account's balance and cumulative site spend.
# This is what makes week/month comparison possible - a checkin only records the
# balance at the moment of signing in, so spend between two checkins would be
# invisible. One observation point per account per day is enough for the deltas.
Add-Content -Path $log -Encoding UTF8 -Value "`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') daily snapshot ====="
$snap = Invoke-Zenx @("accounts", "snapshot", "--all")
if (0 -ne $snap) {
  Add-Content -Path $log -Encoding UTF8 -Value "--- snapshot incomplete (some accounts offline or logged out); ok=false rows still stored"
}

# Always leave a clean desktop, even when a checkin failed part-way through.
$leftover = Close-LeftoverSessions
if ($leftover -gt 0) {
  Add-Content -Path $log -Encoding UTF8 -Value "--- closed $leftover leftover session(s)"
}
Disable-SleepGuard   # release before every exit path; a crash also releases it (process-scoped)
Add-Content -Path $log -Encoding UTF8 -Value "===== failed: $($failed -join ', ') ====="
if ($failed.Count -eq 0) { exit 0 }
# 2 = only accounts that were already known-bad before this run; nothing new broke.
# 1 = at least one account failed during this run and needs attention.
$onlySkipped = @($failed | Where-Object { $_ -like "*(skipped)*" }).Count -eq $failed.Count
if ($onlySkipped) { exit 2 } else { exit 1 }
