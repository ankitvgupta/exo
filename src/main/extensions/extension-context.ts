import type {
  ExtensionContext,
  ExtensionStorage,
  ExtensionSecrets,
  ExtensionLogger,
} from "../../shared/extension-types";
import {
  getExtensionStorage,
  setExtensionStorage,
  deleteExtensionStorage,
} from "../db";

/**
 * Create storage API for an extension
 */
function createStorage(extensionId: string): ExtensionStorage {
  return {
    async get<T>(key: string): Promise<T | null> {
      const value = getExtensionStorage(extensionId, key);
      if (value === null) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as unknown as T;
      }
    },

    async set<T>(key: string, value: T): Promise<void> {
      const serialized = JSON.stringify(value);
      setExtensionStorage(extensionId, key, serialized);
    },

    async delete(key: string): Promise<void> {
      deleteExtensionStorage(extensionId, key);
    },
  };
}

/**
 * Create secrets API for an extension.
 *
 * Stores secrets in the extension's DB storage (under ~/Library/Application
 * Support/exo/ on macOS). Previously used Electron safeStorage
 * (Keychain) for encryption, but that triggers "wants to access data from
 * other apps" prompts whenever the code signing identity changes between
 * builds. The DB directory is already user-protected, so the marginal
 * security benefit wasn't worth the UX cost.
 */
function createSecrets(extensionId: string): ExtensionSecrets {
  const storage = createStorage(extensionId);
  const secretPrefix = "__secret__";

  return {
    async get(key: string): Promise<string | null> {
      return storage.get<string>(`${secretPrefix}${key}`);
    },

    async set(key: string, value: string): Promise<void> {
      await storage.set(`${secretPrefix}${key}`, value);
    },

    async delete(key: string): Promise<void> {
      await storage.delete(`${secretPrefix}${key}`);
    },
  };
}

/**
 * Create logger for an extension
 */
function createLogger(extensionId: string): ExtensionLogger {
  const prefix = `[Ext:${extensionId}]`;

  return {
    info(message: string, ...args: unknown[]) {
      console.log(prefix, message, ...args);
    },
    warn(message: string, ...args: unknown[]) {
      console.warn(prefix, message, ...args);
    },
    error(message: string, ...args: unknown[]) {
      console.error(prefix, message, ...args);
    },
    debug(message: string, ...args: unknown[]) {
      console.debug(prefix, message, ...args);
    },
  };
}

/**
 * Create a complete extension context
 */
export function createExtensionContext(
  extensionId: string,
  extensionPath: string
): ExtensionContext {
  return {
    extensionId,
    extensionPath,
    storage: createStorage(extensionId),
    secrets: createSecrets(extensionId),
    logger: createLogger(extensionId),
  };
}
