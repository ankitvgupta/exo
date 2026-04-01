import { ipcMain, BrowserWindow } from "electron";

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

// Track which webContents have the found-in-page listener attached
const attachedWebContentsIds = new Set<number>();

function ensureFoundInPageListener(win: BrowserWindow): void {
  const id = win.webContents.id;
  if (attachedWebContentsIds.has(id)) return;
  attachedWebContentsIds.add(id);

  win.webContents.on("found-in-page", (_event, result) => {
    win.webContents.send("find:result", {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });

  // Clean up when the window is closed
  win.on("closed", () => {
    attachedWebContentsIds.delete(id);
  });
}

export function registerFindIpc(): void {
  ipcMain.handle(
    "find:find",
    (
      _event,
      { text, forward, findNext }: { text: string; forward?: boolean; findNext?: boolean },
    ) => {
      const w = getMainWindow();
      if (!w || !text) return;
      ensureFoundInPageListener(w);
      w.webContents.findInPage(text, { forward: forward ?? true, findNext: findNext ?? false });
    },
  );

  ipcMain.handle("find:stop", () => {
    const w = getMainWindow();
    if (!w) return;
    w.webContents.stopFindInPage("clearSelection");
  });
}
