import {
  formatModifierShortcut,
  formatSymbolShortcut,
  getPlatformInfo,
  type PlatformInfo,
} from "../../shared/platform";

export function getRendererPlatform(): PlatformInfo {
  const api = (window as { api?: { platform?: PlatformInfo } }).api;
  if (api?.platform) return api.platform;
  // The preload injects `api.platform` before the renderer runs, so this branch
  // only hits non-Electron contexts (e.g. unit tests). Use a neutral platform
  // rather than the deprecated navigator.platform, which reports the host OS and
  // could mask platform-specific bugs (e.g. isMac=true when tests run on macOS).
  return getPlatformInfo("unknown");
}

export function modifierShortcut(key: string): string {
  return formatModifierShortcut(key, getRendererPlatform());
}

export function symbolShortcut(key: string): string {
  return formatSymbolShortcut(key, getRendererPlatform());
}
