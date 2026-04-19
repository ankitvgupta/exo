/**
 * Structured logging service for Exo.
 *
 * Uses pino (Layer 1, battle-tested) with:
 * - JSON lines to file in all modes (daily rotation, 7-day retention)
 * - Pretty console output in dev mode
 * - Namespaced child loggers per module
 *
 * REDACTION POLICY: Never log email body/subject content.
 * Only log IDs (email_id, account_id, thread_id, caller).
 */
import pino, { type Logger, multistream } from "pino";
import { type SonicBoom } from "sonic-boom";
import { join } from "path";
import { mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { tmpdir } from "os";
import { Writable } from "stream";

/**
 * Wraps a SonicBoom destination so that writes to a destroyed stream are
 * silently dropped instead of throwing "SonicBoom destroyed". This prevents
 * logger errors from propagating up through IPC handlers during shutdown
 * race conditions (see GitHub issue #67).
 */
function safeSonicBoomWrapper(dest: SonicBoom): Writable & { flushSync?: () => void } {
  const wrapper = new Writable({
    write(chunk, _encoding, callback) {
      try {
        if ((dest as unknown as { destroyed: boolean }).destroyed) {
          callback();
          return;
        }
        dest.write(chunk);
        callback();
      } catch {
        // Swallow write errors (e.g. "SonicBoom destroyed") — logging
        // should never crash the app.
        callback();
      }
    },
    // Intentionally does NOT forward end() to the underlying SonicBoom.
    // closeLogs() calls dest.end() on the raw _destinations refs directly,
    // which flushes SonicBoom's internal buffer before closing.
    final(callback) {
      callback();
    },
  });
  // Expose flushSync so pino's logger.flush() can still synchronously
  // flush the underlying SonicBoom buffer to disk.
  (wrapper as Writable & { flushSync: () => void }).flushSync = () => {
    try {
      if (!(dest as unknown as { destroyed: boolean }).destroyed) dest.flushSync();
    } catch {
      /* best effort */
    }
  };
  return wrapper;
}

// Lazy-require Electron modules so this file can be imported in tests
// without Electron being available.
function getLogDir(): string {
  try {
    // Resolve the data directory inline to avoid a circular dependency
    // with data-dir.ts (which imports createLogger at module scope).
    // NOTE: Keep this path logic in sync with getDataDir() in data-dir.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    // Use app.isPackaged directly — the previous isDev() wrapper used
    // require("@electron-toolkit/utils") which could fail and fall back
    // to NODE_ENV checks that incorrectly returned true in packaged apps.
    const baseDir = app.isPackaged ? app.getPath("userData") : join(app.getAppPath(), ".dev-data");
    return join(baseDir, "logs");
  } catch {
    // Fallback for tests or non-Electron environments.
    return join(tmpdir(), "exo-logs");
  }
}

function isDev(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    return !app.isPackaged;
  } catch {
    return process.env.NODE_ENV !== "production";
  }
}

const LOG_RETENTION_DAYS = 7;

function cleanOldLogs(logDir: string): void {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(logDir)) {
      if (!f.endsWith(".log")) continue;
      const p = join(logDir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* ignore individual file cleanup errors */
      }
    }
  } catch {
    /* ignore if log dir doesn't exist yet */
  }
}

let _logger: Logger | null = null;
// Keep references to SonicBoom destinations so we can end() them on shutdown.
// pino's Logger and MultiStreamRes types don't expose end(), but
// SonicBoom (returned by pino.destination()) does.
let _destinations: SonicBoom[] = [];

function initLogger(): Logger {
  const logDir = getLogDir();
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (e) {
    // Don't silently swallow — leave a breadcrumb so we can debug startup
    // failures like the fd=-1 crash in issue #97.
    // eslint-disable-next-line no-console
    console.error("[logger] Failed to create log directory:", logDir, e);
  }

  cleanOldLogs(logDir);

  const today = new Date().toISOString().split("T")[0];
  const logFile = join(logDir, `${today}.log`);
  const dev = isDev();

  // pino.destination() returns SonicBoom at runtime but is typed as DestinationStream.
  // Attach an error handler immediately so that if the file descriptor fails to
  // open (fd = -1), the error is swallowed rather than crashing the app with
  // an unhandled "fd is out of range" RangeError (see GitHub issue #97).
  const fileDest = pino.destination({ dest: logFile, sync: false, mkdir: true }) as SonicBoom;
  fileDest.on("error", (err) => {
    // Best-effort: log to stderr so there's a breadcrumb, but never throw.
    // eslint-disable-next-line no-console
    console.error("[logger] SonicBoom file destination error:", err);
  });
  _destinations = [fileDest];

  const streams: pino.StreamEntry[] = [
    // Async writes — closeLogs() ends the SonicBoom destinations in before-quit,
    // deregistering pino's exit hook to prevent "sonic boom is not ready yet" crash.
    // Wrapped in safeSonicBoomWrapper so writes after destroy are silently dropped.
    {
      level: "debug" as const,
      stream: safeSonicBoomWrapper(fileDest),
    },
  ];

  if (dev) {
    // In dev, also write pretty output to stdout
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pinoPretty = require("pino-pretty");
      const prettyStream = pinoPretty({ colorize: true });
      prettyStream.on("error", (err: Error) => {
        // eslint-disable-next-line no-console
        console.error("[logger] pino-pretty stream error:", err);
      });
      streams.push({
        level: "debug" as const,
        stream: prettyStream,
      });
    } catch {
      // pino-pretty not available, fall back to raw JSON to stdout
      const stdoutDest = pino.destination({ dest: 1, sync: true }) as SonicBoom;
      stdoutDest.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.error("[logger] SonicBoom stdout destination error:", err);
      });
      _destinations.push(stdoutDest);
      streams.push({
        level: "debug" as const,
        stream: safeSonicBoomWrapper(stdoutDest),
      });
    }
  }

  return pino(
    {
      level: dev ? "debug" : "info",
      // Redact sensitive paths that might contain email content
      redact: {
        paths: [
          "body",
          "htmlBody",
          "html_body",
          "bodyText",
          "body_text",
          "subject",
          "snippet",
          "emailContent",
          "prompt",
        ],
        censor: "[REDACTED]",
      },
    },
    multistream(streams),
  );
}

/**
 * Create a namespaced logger for a module.
 *
 * Usage:
 *   const log = createLogger("analyzer");
 *   log.info("Email analyzed", { emailId: "abc", needsReply: true });
 */
export function createLogger(namespace: string): Logger {
  if (!_logger) _logger = initLogger();
  return _logger.child({ ns: namespace });
}

/**
 * Get the raw root logger (prefer createLogger for namespacing).
 */
export function getRawLogger(): Logger {
  if (!_logger) _logger = initLogger();
  return _logger;
}

/**
 * Flush all pending log writes. Call before app exit.
 */
export function flushLogs(): void {
  if (_logger) {
    _logger.flush();
  }
}

/**
 * Flush and close the logger, deregistering pino's process-exit hook.
 * Call in before-quit to prevent SonicBoom errors during shutdown.
 */
export function closeLogs(): void {
  if (_logger) {
    try {
      _logger.flush();
    } catch {
      /* best effort */
    }
    // End each SonicBoom destination — this deregisters pino's
    // on-exit-leak-free handler, preventing the "sonic boom is not ready yet" crash.
    for (const dest of _destinations) {
      try {
        dest.end();
      } catch {
        /* best effort */
      }
    }
    _destinations = [];
    _logger = null;
  }
}
