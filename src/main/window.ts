import { BrowserWindow, shell, nativeTheme, app } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import { getConfig } from "./ipc/settings.ipc";

export function getIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }
  return join(__dirname, "../../resources/icon.png");
}

let mainWindow: BrowserWindow | null = null;

// Check if running in test/headless mode
const isTestMode = process.env.NODE_ENV === "test" || process.env.EXO_HEADLESS === "true";

// Resolve initial background color from persisted theme to prevent white flash
function getInitialBackgroundColor(): string {
  try {
    const config = getConfig();
    const theme = config.theme || "system";
    const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
    return isDark ? "#111827" : "#f3f4f6"; // gray-900 / gray-100
  } catch {
    return "#f3f4f6"; // default to light
  }
}

// Check if vibrancy is enabled in persisted appearance config
function getInitialVibrancy(): boolean {
  try {
    const config = getConfig();
    return config.appearance?.vibrancy === true;
  } catch {
    return false;
  }
}

// Apply or remove vibrancy on a BrowserWindow at runtime.
// The window is always created with transparent:true, so toggling
// vibrancy just adds/removes the OS blur — CSS handles the alpha.
export function applyVibrancy(win: BrowserWindow, enabled: boolean): void {
  if (process.platform === "darwin") {
    win.setVibrancy(enabled ? "under-window" : null);
  } else if (process.platform === "win32") {
    win.setBackgroundMaterial(enabled ? "acrylic" : "none");
  }
}

export function createWindow(): BrowserWindow {
  const vibrancyEnabled = getInitialVibrancy();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 15, y: 15 },
    icon: getIconPath(),

    // transparent must be set at creation — cannot be toggled later.
    // Always enable it so vibrancy can be turned on/off at runtime.
    transparent: true,
    backgroundColor: "#00000000",

    // macOS frosted glass (if persisted from last session)
    ...(vibrancyEnabled &&
      process.platform === "darwin" && {
        vibrancy: "under-window" as const,
        visualEffectState: "active" as const,
      }),

    // Windows 11 acrylic
    ...(vibrancyEnabled &&
      process.platform === "win32" && {
        backgroundMaterial: "acrylic" as const,
      }),
    // Prevent Chromium from throttling timers in hidden windows during tests.
    // Without this, setTimeout-based logic (e.g. undo-send toast auto-dismiss)
    // gets frozen indefinitely when the window is never shown.
    ...(isTestMode && { backgroundThrottling: false }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false, // ESM preload requires sandbox disabled
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading external images in emails
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    // Don't show window in test/headless mode
    if (!isTestMode) {
      mainWindow?.show();
    }
  });

  // Intercept keyboard shortcuts before they reach the page.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    // Cmd/Ctrl+F → open find bar
    const isFindModifier = process.platform === "darwin" ? input.meta : input.control;
    if (input.key === "f" && isFindModifier) {
      event.preventDefault();
      mainWindow?.webContents.send("find:open");
      return;
    }

    // Enter cycling is handled in the renderer (FindBar.tsx window-level
    // keydown listener) — before-input-event doesn't reliably fire for all
    // input methods (e.g. CDP key injection).
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
