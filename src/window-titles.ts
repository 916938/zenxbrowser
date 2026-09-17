import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { markerFromTitles, markerMatches } from "./profile-marker.ts";

const execFileAsync = promisify(execFile);

/**
 * 通过 PowerShell 枚举可见的 Edge 窗口标题。
 * 只在 Windows 上可用；其它平台返回空数组，调用方据此报"无法定位"。
 */
const SCRIPT = `$titles = @()
Add-Type -Namespace Zenx -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, System.IntPtr l);
public delegate bool EnumWindowsProc(System.IntPtr h, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
'@ -ErrorAction SilentlyContinue
$callback = [Zenx.Win+EnumWindowsProc]{
  param($h, $l)
  if ([Zenx.Win]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Zenx.Win]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t -match 'Microsoft') { $script:titles += $t }
  }
  return $true
}
[void][Zenx.Win]::EnumWindows($callback, [System.IntPtr]::Zero)
$titles | ForEach-Object { $_ }
`;

export async function listEdgeWindowTitles(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    // 枚举失败当作没有新窗口：宁可报"定位失败"，也不能猜。
    return [];
  }
}

/**
 * 探测某次操作新开窗口属于哪个 Profile，并判断是否匹配目标 Profile。
 * 先在操作前拍快照，再在调用方完成操作后调用本函数比较。
 */
export async function detectProfile(
  before: string[],
  profileDirectory: string,
): Promise<string | null> {
  const after = await listEdgeWindowTitles();
  const marker = markerFromTitles(before, after);
  return markerMatches(marker, profileDirectory) ? marker : null;
}

export { listEdgeWindowTitles as listEdgeWindowTitlesForTest };
