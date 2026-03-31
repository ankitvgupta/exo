import { ipcMain, app, dialog, shell } from "electron";
import { basename, join, extname } from "path";
import { writeFile, mkdir, access } from "fs/promises";
import { getEmailSyncService } from "./sync.ipc";
import { getEmail } from "../db";
import type { IpcResponse, AttachmentMeta } from "../../shared/types";

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

// Placeholder base64 data for demo mode previews
const DEMO_PREVIEW_PNG =
  "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";

const DEMO_PREVIEW_PDF =
  "JVBERi0xLjQKMSAwIG9iaiA8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4gZW5kb2JqCjIgMCBvYmogPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4gZW5kb2JqCjMgMCBvYmogPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4gZW5kb2JqCjQgMCBvYmogPDwgL0xlbmd0aCAyMjAgPj4gc3RyZWFtCkJUIC9GMSAyNCBUZiA3MiA3MDAgVGQgKFEzIFF1YXJ0ZXJseSBSZXBvcnQgMjAyNSkgVGogMCAtNDAgVGQgL0YxIDE0IFRmIChUZWNoQ29ycCBJbmMuIC0gQ29uZmlkZW50aWFsKSBUaiAwIC0zMCBUZCAoUmV2ZW51ZTogJDEuMk0gfCBVc2VyczogNDUsMDAwIHwgUmV0ZW50aW9uOiA3MiUpIFRqIDAgLTMwIFRkIChUaGlzIGlzIGEgZGVtbyBwcmV2aWV3IHBsYWNlaG9sZGVyLikgVGogRVQKZW5kc3RyZWFtIGVuZG9iago1IDAgb2JqIDw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PiBlbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDA1MTIgMDAwMDAgbiAKdHJhaWxlciA8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo1ODIKJSVFT0Y=";

/**
 * Convert Gmail's base64url data to a standard base64 string
 */
function base64urlToBase64(data: string): string {
  let result = data.replace(/-/g, "+").replace(/_/g, "/");
  // Restore padding — base64url often omits trailing '='
  const pad = result.length % 4;
  if (pad === 2) result += "==";
  else if (pad === 3) result += "=";
  return result;
}

/**
 * If `filePath` already exists, append (1), (2), … before the extension
 * until we find a name that doesn't collide.
 */
async function uniquePath(filePath: string): Promise<string> {
  let candidate = filePath;
  let i = 1;
  const ext = extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  while (true) {
    try {
      await access(candidate);
      candidate = `${base} (${i++})${ext}`;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw err;
    }
  }
}

export function registerAttachmentsIpc(): void {
  // Download an attachment to the app's data directory and reveal in Finder.
  // Saves under ~/Library/Application Support/exo/downloads/ (macOS)
  // to avoid TCC prompts for ~/Downloads, iCloud, or network volumes.
  ipcMain.handle(
    "attachments:download",
    async (
      _,
      {
        emailId,
        attachmentId,
        filename,
        accountId,
      }: {
        emailId: string;
        attachmentId: string;
        filename: string;
        accountId: string;
      },
    ): Promise<IpcResponse<{ filePath: string }>> => {
      try {
        const downloadsDir = join(app.getPath("userData"), "downloads");
        await mkdir(downloadsDir, { recursive: true });

        const safeFilename = basename(filename);
        const filePath = await uniquePath(join(downloadsDir, safeFilename));

        let buffer: Buffer;

        if (useFakeData) {
          const email = getEmail(emailId);
          const att = email?.attachments?.find(
            (a: AttachmentMeta) => a.attachmentId === attachmentId,
          );
          if (att?.mimeType.startsWith("image/")) {
            buffer = Buffer.from(DEMO_PREVIEW_PNG, "base64");
          } else if (att?.mimeType === "application/pdf") {
            buffer = Buffer.from(DEMO_PREVIEW_PDF, "base64");
          } else {
            buffer = Buffer.from("Demo attachment placeholder content", "utf-8");
          }
        } else {
          const syncService = getEmailSyncService();
          const client = syncService.getClientForAccount(accountId);
          if (!client) {
            return { success: false, error: `No client for account ${accountId}` };
          }

          const data = await client.getAttachment(emailId, attachmentId);
          buffer = Buffer.from(base64urlToBase64(data), "base64");
        }

        await writeFile(filePath, buffer);
        shell.showItemInFolder(filePath);

        return { success: true, data: { filePath } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to download attachment",
        };
      }
    },
  );

  // Get attachment data for preview (returns base64)
  ipcMain.handle(
    "attachments:preview",
    async (
      _,
      {
        emailId,
        attachmentId,
        accountId,
      }: {
        emailId: string;
        attachmentId: string;
        accountId: string;
      },
    ): Promise<IpcResponse<{ data: string }>> => {
      if (useFakeData) {
        // Return placeholder preview data for demo previewable types
        const email = getEmail(emailId);
        const att = email?.attachments?.find(
          (a: AttachmentMeta) => a.attachmentId === attachmentId,
        );
        if (att) {
          if (att.mimeType.startsWith("image/")) {
            return { success: true, data: { data: DEMO_PREVIEW_PNG } };
          }
          if (att.mimeType === "application/pdf") {
            return { success: true, data: { data: DEMO_PREVIEW_PDF } };
          }
        }
        return { success: false, error: "Preview not available for this file type" };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        const data = await client.getAttachment(emailId, attachmentId);
        // Convert from base64url to standard base64
        const base64Data = base64urlToBase64(data);

        return { success: true, data: { data: base64Data } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get attachment preview",
        };
      }
    },
  );

  // Open file picker dialog for attaching files
  ipcMain.handle(
    "attachments:pick-files",
    async (): Promise<
      IpcResponse<Array<{ filename: string; path: string; mimeType: string; size: number }>>
    > => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ["openFile", "multiSelections"],
          title: "Attach Files",
        });

        if (result.canceled || result.filePaths.length === 0) {
          return { success: true, data: [] };
        }

        const { stat } = await import("fs/promises");
        const { lookup } = await import("mime-types");

        const files = await Promise.all(
          result.filePaths.map(async (filePath) => {
            const stats = await stat(filePath);
            const filename = basename(filePath) || "file";
            const mimeType = lookup(filename) || "application/octet-stream";
            return {
              filename,
              path: filePath,
              mimeType,
              size: stats.size,
            };
          }),
        );

        return { success: true, data: files };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to pick files",
        };
      }
    },
  );

  // Get attachment data for forwarding (returns base64 content for each attachment)
  ipcMain.handle(
    "attachments:get-for-forward",
    async (
      _,
      { emailId, accountId }: { emailId: string; accountId: string },
    ): Promise<IpcResponse<Array<{ filename: string; mimeType: string; content: string }>>> => {
      if (useFakeData) {
        return { success: true, data: [] };
      }

      try {
        const email = getEmail(emailId);
        if (!email?.attachments?.length) {
          return { success: true, data: [] };
        }

        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        const attachmentData = await Promise.all(
          email.attachments
            .filter((att: AttachmentMeta) => att.attachmentId)
            .map(async (att: AttachmentMeta) => {
              const data = await client.getAttachment(emailId, att.attachmentId!);
              return {
                filename: att.filename,
                mimeType: att.mimeType,
                content: base64urlToBase64(data),
              };
            }),
        );

        return { success: true, data: attachmentData };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get attachments for forward",
        };
      }
    },
  );
}
