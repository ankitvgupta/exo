import {
  formatModifierShortcut,
  formatSymbolShortcut,
  getPlatformInfo,
  type PlatformInfo,
} from "../../shared/platform";

export function getRendererPlatform(): PlatformInfo {
  const api = (window as { api?: { platform?: PlatformInfo } }).api;
  return api?.platform ?? getPlatformInfo(navigator.platform);
}

export function modifierShortcut(key: string): string {
  return formatModifierShortcut(key, getRendererPlatform());
}

export function symbolShortcut(key: string): string {
  return formatSymbolShortcut(key, getRendererPlatform());
}
