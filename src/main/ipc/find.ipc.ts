import { ipcMain, BrowserWindow } from "electron";

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

export function registerFindIpc(): void {
  let lastFindText = "";
  let reestablishing = false;
  let listenerAttached = false;

  // Attach the found-in-page listener lazily (the window may not exist yet
  // when registerFindIpc is called). Only attached once.
  function ensureListener(w: BrowserWindow): void {
    if (listenerAttached) return;
    listenerAttached = true;

    // Track all events for debugging
    (global as any).__findDebug = { events: [], reestablishResults: [], ipcCalls: [] };

    w.webContents.on("found-in-page", (_event, result) => {
      const entry = {
        ordinal: result.activeMatchOrdinal,
        matches: result.matches,
        reest: reestablishing,
        ts: Date.now(),
      };
      (global as any).__findDebug.events.push(entry);

      if (reestablishing) {
        reestablishing = false;
        (global as any).__findDebug.reestablishResults.push(entry);
        return;
      }

      w.webContents.send("find:result", {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });

      if (lastFindText) {
        reestablishing = true;
        setTimeout(() => {
          if (!w.isDestroyed()) {
            w.webContents.findInPage(lastFindText, { findNext: true, forward: true });
          }
        }, 50);
      }
    });

    w.on("closed", () => {
      listenerAttached = false;
      lastFindText = "";
    });
  }

  // Fire-and-forget: call findInPage, results come back via found-in-page.
  // Always use findNext: true — Electron doesn't fire found-in-page for
  // findNext: false when called from an IPC handler.
  ipcMain.on(
    "find:find",
    (
      _event,
      { text, forward }: { text: string; forward?: boolean; findNext?: boolean },
    ) => {
      const w = getMainWindow();
      if (!w || !text) return;
      ensureListener(w);
      lastFindText = text;
      if ((global as any).__findDebug) {
        (global as any).__findDebug.ipcCalls.push({ text, forward, ts: Date.now() });
      }
      setImmediate(() => {
        if (!w.isDestroyed()) {
          w.webContents.findInPage(text, { forward: forward ?? true, findNext: true });
        }
      });
    },
  );

  ipcMain.on("find:stop", () => {
    const w = getMainWindow();
    if (!w) return;
    lastFindText = "";
    reestablishing = false;
    w.webContents.stopFindInPage("clearSelection");
  });
}
