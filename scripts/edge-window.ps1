param(
  [Parameter(Mandatory = $true)][string[]]$Marker,
  [ValidateSet("Focus", "Close")][string]$Action = "Focus"
)

# Focus or close the Edge windows that belong to a profile.
#
# Why this exists: a hidden (background / occluded) Edge window renders no
# balance and silently swallows CDP input. Symptoms are misleading:
#   - checkin  -> LOGOUT_FAILED even though the logout did take effect
#   - snapshot -> balance/totalSpent null, sometimes 0
# Focusing the profile window first fixes both.
#
# Marker is the profile DISPLAY NAME shown in the window title
# ("<page> - <display name> - Microsoft Edge"), NOT the profile directory
# number: several profiles on this machine were renamed. Authoritative mapping
# lives in "User Data\Local State" -> profile.info_cache.
#
# Known display names on this machine:
#   edge-1 -> 1        edge-2  -> 2          edge-3 (Default) -> 3
#   edge-4 -> rishu365 4   edge-5 -> FuLawyer   edge-6..edge-10 -> 6..10
#   edge-p3  -> 916938 13  edge-p11 -> 11       edge-p12 -> 12
#   edge-p13 -> 14 learnima  edge-p14 -> 15
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\edge-window.ps1 -Marker "916938 13"
#   powershell -ExecutionPolicy Bypass -File scripts\edge-window.ps1 -Marker "11","12" -Action Close
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses a BOM-less
# .ps1 as ANSI, so non-ASCII characters turn into mojibake.

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ZenxEdgeWindow {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int Apply(string marker, bool close) {
    int n = 0;
    EnumWindows(new EnumWindowsProc(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        string t = sb.ToString();
        if (t.Length > 0 && t.Contains(" - " + marker + " - ")) {
          if (close) {
            PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);          // WM_CLOSE: graceful shutdown
          } else {
            ShowWindow(h, 9);                                          // SW_RESTORE
            SetForegroundWindow(h);
          }
          n++;
        }
      }
      return true;
    }), IntPtr.Zero);
    return n;
  }
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop

$total = 0
foreach ($m in $Marker) {
  $n = [ZenxEdgeWindow]::Apply($m, ($Action -eq "Close"))
  $total += $n
  Write-Output ("{0}: {1} window(s) -> {2}" -f $m, $n, $Action)
}

if ($total -eq 0) {
  Write-Output "No window matched. Check the profile display name (User Data\Local State -> profile.info_cache)."
}
Write-Output "total: $total"
