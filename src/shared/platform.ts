export type RuntimePlatform = string;

export interface PlatformInfo {
  platform: RuntimePlatform;
  isMac: boolean;
  modifierKey: "Cmd" | "Ctrl";
  modifierSymbol: "\u2318" | "Ctrl+";
}

export function getPlatformInfo(platform: RuntimePlatform): PlatformInfo {
  const isMac = platform === "darwin" || /^mac/i.test(platform);
  return {
    platform,
    isMac,
    modifierKey: isMac ? "Cmd" : "Ctrl",
    modifierSymbol: isMac ? "\u2318" : "Ctrl+",
  };
}

export function formatModifierShortcut(key: string, platform: PlatformInfo): string {
  return `${platform.modifierKey}+${key}`;
}

export function formatSymbolShortcut(key: string, platform: PlatformInfo): string {
  return `${platform.modifierSymbol}${key}`;
}
