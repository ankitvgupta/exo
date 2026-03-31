/**
 * Runtime loader for installed (non-bundled) extension panel components.
 *
 * Installed extensions are loaded at runtime by fetching their renderer bundle
 * from the main process via IPC, then dynamically evaluating it.
 *
 * The renderer bundle is an ESM module that exports `panelRegistrations`:
 *   [{ extensionId: string, panelId: string, component: React.ComponentType }]
 *
 * React and ReactDOM are provided as externals — the extension bundle references
 * them but the host app provides them at runtime via globalThis shims.
 */

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as JsxRuntime from "react/jsx-runtime";
import { registerPanelComponent, type PanelComponentProps } from "./ExtensionPanelSlot";
import type { InstalledExtensionInfo } from "../../shared/extension-types";

// Expose React on globalThis so extension bundles can access it.
// esbuild's --external:react produces bare imports that won't resolve from
// blob URLs. We rewrite those imports to point at data: URLs that re-export
// from these globals.
(globalThis as Record<string, unknown>).__MAIL_EXT_REACT__ = React;
(globalThis as Record<string, unknown>).__MAIL_EXT_REACT_DOM__ = ReactDOM;
(globalThis as Record<string, unknown>).__MAIL_EXT_JSX_RUNTIME__ = JsxRuntime;

interface PanelRegistration {
  extensionId: string;
  panelId: string;
  component: React.ComponentType<PanelComponentProps>;
}

interface InstalledExtensionRendererModule {
  panelRegistrations?: PanelRegistration[];
}

/**
 * Load and register panel components for all installed extensions.
 * Called at app startup and when a new extension is installed.
 */
export async function loadInstalledExtensionPanels(): Promise<void> {
  try {
    const result = (await window.api.extensions.listInstalled()) as {
      success: boolean;
      data?: InstalledExtensionInfo[];
    };

    if (!result.success || !result.data) return;

    for (const ext of result.data) {
      if (ext.hasRenderer) {
        await loadExtensionRenderer(ext.id);
      }
    }
  } catch (error) {
    console.warn("[Extensions] Failed to load installed extension panels:", error);
  }
}

/**
 * Rewrite bare React imports in an ESM bundle to use globalThis references.
 *
 * esbuild with --external:react produces imports like:
 *   import { useState } from "react";
 *   import { jsx } from "react/jsx-runtime";
 *
 * These can't resolve from blob: URLs. We replace them with inline references
 * to the globals we set above.
 */
function rewriteReactImports(code: string): string {
  // Replace: import { ... } from "react/jsx-runtime"
  // With:    const { ... } = globalThis.__MAIL_EXT_JSX_RUNTIME__
  code = code.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']react\/jsx-runtime["']\s*;?/g,
    "const {$1} = globalThis.__MAIL_EXT_JSX_RUNTIME__;",
  );

  // Replace: import { ... } from "react-dom"
  // With:    const { ... } = globalThis.__MAIL_EXT_REACT_DOM__
  code = code.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']react-dom["']\s*;?/g,
    "const {$1} = globalThis.__MAIL_EXT_REACT_DOM__;",
  );

  // Replace: import { ... } from "react"
  // With:    const { ... } = globalThis.__MAIL_EXT_REACT__
  code = code.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']react["']\s*;?/g,
    "const {$1} = globalThis.__MAIL_EXT_REACT__;",
  );

  // Replace: import React from "react"  (default import)
  code = code.replace(
    /import\s+(\w+)\s+from\s*["']react["']\s*;?/g,
    "const $1 = globalThis.__MAIL_EXT_REACT__;",
  );

  // Replace: import * as React from "react"  (namespace import)
  code = code.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*["']react["']\s*;?/g,
    "const $1 = globalThis.__MAIL_EXT_REACT__;",
  );

  return code;
}

/**
 * Load renderer bundle for a single installed extension.
 */
export async function loadExtensionRenderer(extensionId: string): Promise<void> {
  try {
    const result = (await window.api.extensions.getRendererBundle(extensionId)) as {
      success: boolean;
      data?: string;
      error?: string;
    };

    if (!result.success || !result.data) {
      console.warn(`[Extensions] No renderer bundle for ${extensionId}: ${result.error}`);
      return;
    }

    // Rewrite bare React imports to use globalThis references,
    // then load via blob URL as a standard ESM module.
    const rewrittenCode = rewriteReactImports(result.data);
    const blob = new Blob([rewrittenCode], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const module = (await import(/* @vite-ignore */ blobUrl)) as InstalledExtensionRendererModule;

      if (module.panelRegistrations) {
        for (const reg of module.panelRegistrations) {
          registerPanelComponent(reg.extensionId, reg.panelId, reg.component);
          console.log(`[Extensions] Registered installed panel: ${reg.extensionId}:${reg.panelId}`);
        }
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (error) {
    console.warn(`[Extensions] Failed to load renderer for ${extensionId}:`, error);
  }
}
