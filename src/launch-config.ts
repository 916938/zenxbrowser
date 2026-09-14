import { win32 } from "node:path";

export type LaunchConfig = {
  edgePath: string;
  userDataDir: string;
  profileDirectory: string;
};

function absoluteWindowsPath(value: unknown, local: boolean): value is string {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f"<>|?*]/.test(value)) return false;
  const normalized = value.replace(/\//g, "\\");
  if (/^[a-z]:\\/i.test(normalized)) return !normalized.slice(2).includes(":");
  return !local && /^\\\\[^\\:]+\\[^\\:]+(?:\\[^:]*)?$/.test(normalized);
}

export function isLaunchConfig(value: unknown): value is LaunchConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (!absoluteWindowsPath(config.edgePath, true) || win32.basename(config.edgePath).toLowerCase() !== "msedge.exe") return false;
  if (!absoluteWindowsPath(config.userDataDir, false)) return false;
  const profile = config.profileDirectory;
  return typeof profile === "string" && profile.length > 0 && profile.length <= 255 &&
    profile !== "." && profile !== ".." && !/[\\/"<>:|?*\x00-\x1f\x7f]/.test(profile) &&
    !/[. ]$/.test(profile) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(profile);
}
