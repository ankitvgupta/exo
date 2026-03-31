/**
 * Unit tests for extension-types.ts Zod schemas.
 * These schemas are importable directly (no electron dependency).
 */
import { test, expect } from "@playwright/test";
import {
  ExtensionManifestSchema,
  SidebarPanelContributionSchema,
  SettingDefinitionSchema,
  EnrichmentDataSchema,
  ExtensionContributesSchema,
} from "../../src/shared/extension-types";

// ============================================================
// SidebarPanelContributionSchema
// ============================================================

test.describe("SidebarPanelContributionSchema", () => {
  test("validates a minimal panel with defaults", () => {
    const result = SidebarPanelContributionSchema.parse({
      id: "my-panel",
      title: "My Panel",
    });
    expect(result.id).toBe("my-panel");
    expect(result.title).toBe("My Panel");
    expect(result.priority).toBe(50);
    expect(result.scope).toBe("sender");
  });

  test("accepts explicit priority and scope", () => {
    const result = SidebarPanelContributionSchema.parse({
      id: "p1",
      title: "Panel",
      priority: 100,
      scope: "email",
    });
    expect(result.priority).toBe(100);
    expect(result.scope).toBe("email");
  });

  test("rejects invalid scope value", () => {
    expect(() =>
      SidebarPanelContributionSchema.parse({
        id: "p1",
        title: "Panel",
        scope: "thread",
      }),
    ).toThrow();
  });

  test("rejects missing id", () => {
    expect(() => SidebarPanelContributionSchema.parse({ title: "Panel" })).toThrow();
  });

  test("rejects missing title", () => {
    expect(() => SidebarPanelContributionSchema.parse({ id: "p1" })).toThrow();
  });
});

// ============================================================
// SettingDefinitionSchema
// ============================================================

test.describe("SettingDefinitionSchema", () => {
  test("validates a boolean setting", () => {
    const result = SettingDefinitionSchema.parse({
      id: "enabled",
      type: "boolean",
      default: true,
      title: "Enable Feature",
    });
    expect(result.id).toBe("enabled");
    expect(result.type).toBe("boolean");
    expect(result.default).toBe(true);
    expect(result.description).toBeUndefined();
  });

  test("validates a string setting with description", () => {
    const result = SettingDefinitionSchema.parse({
      id: "api-key",
      type: "string",
      default: "sk-xxx",
      title: "API Key",
      description: "Your API key",
    });
    expect(result.description).toBe("Your API key");
    expect(result.default).toBe("sk-xxx");
  });

  test("validates a number setting", () => {
    const result = SettingDefinitionSchema.parse({
      id: "timeout",
      type: "number",
      default: 30,
      title: "Timeout",
    });
    expect(result.default).toBe(30);
  });

  test("rejects invalid type", () => {
    expect(() =>
      SettingDefinitionSchema.parse({
        id: "x",
        type: "array",
        default: [],
        title: "X",
      }),
    ).toThrow();
  });

  test("rejects missing default", () => {
    expect(() =>
      SettingDefinitionSchema.parse({
        id: "x",
        type: "boolean",
        title: "X",
      }),
    ).toThrow();
  });

  test("rejects missing title", () => {
    expect(() =>
      SettingDefinitionSchema.parse({
        id: "x",
        type: "string",
        default: "",
      }),
    ).toThrow();
  });
});

// ============================================================
// EnrichmentDataSchema
// ============================================================

test.describe("EnrichmentDataSchema", () => {
  test("validates enrichment with required fields", () => {
    const result = EnrichmentDataSchema.parse({
      extensionId: "ext-1",
      panelId: "panel-1",
      data: { score: 42, label: "important" },
    });
    expect(result.extensionId).toBe("ext-1");
    expect(result.panelId).toBe("panel-1");
    expect(result.data).toEqual({ score: 42, label: "important" });
    expect(result.expiresAt).toBeUndefined();
  });

  test("accepts optional expiresAt", () => {
    const result = EnrichmentDataSchema.parse({
      extensionId: "ext-1",
      panelId: "panel-1",
      data: {},
      expiresAt: 1700000000,
    });
    expect(result.expiresAt).toBe(1700000000);
  });

  test("accepts empty data record", () => {
    const result = EnrichmentDataSchema.parse({
      extensionId: "ext-1",
      panelId: "panel-1",
      data: {},
    });
    expect(result.data).toEqual({});
  });

  test("rejects missing extensionId", () => {
    expect(() => EnrichmentDataSchema.parse({ panelId: "p", data: {} })).toThrow();
  });

  test("rejects missing panelId", () => {
    expect(() => EnrichmentDataSchema.parse({ extensionId: "e", data: {} })).toThrow();
  });

  test("rejects missing data", () => {
    expect(() => EnrichmentDataSchema.parse({ extensionId: "e", panelId: "p" })).toThrow();
  });
});

// ============================================================
// ExtensionManifestSchema
// ============================================================

test.describe("ExtensionManifestSchema", () => {
  test("validates a minimal manifest with defaults", () => {
    const result = ExtensionManifestSchema.parse({
      id: "my-ext",
      displayName: "My Extension",
    });
    expect(result.id).toBe("my-ext");
    expect(result.displayName).toBe("My Extension");
    expect(result.version).toBe("1.0.0");
    expect(result.builtIn).toBe(false);
    expect(result.activationEvents).toEqual(["onEmail"]);
    expect(result.description).toBeUndefined();
    expect(result.contributes).toBeUndefined();
  });

  test("accepts all explicit fields", () => {
    const result = ExtensionManifestSchema.parse({
      id: "ext-full",
      displayName: "Full Extension",
      description: "A fully specified extension",
      version: "2.3.1",
      builtIn: true,
      activationEvents: ["onEmail", "onStartup"],
      contributes: {
        sidebarPanels: [{ id: "sp1", title: "Sidebar" }],
        settings: [{ id: "s1", type: "boolean", default: false, title: "Toggle" }],
      },
    });
    expect(result.version).toBe("2.3.1");
    expect(result.builtIn).toBe(true);
    expect(result.activationEvents).toEqual(["onEmail", "onStartup"]);
    expect(result.contributes?.sidebarPanels).toHaveLength(1);
    expect(result.contributes?.sidebarPanels?.[0].priority).toBe(50); // default applied
    expect(result.contributes?.settings).toHaveLength(1);
  });

  test("rejects missing id", () => {
    expect(() => ExtensionManifestSchema.parse({ displayName: "No ID" })).toThrow();
  });

  test("rejects missing displayName", () => {
    expect(() => ExtensionManifestSchema.parse({ id: "no-name" })).toThrow();
  });

  test("contributes can be empty object", () => {
    const result = ExtensionManifestSchema.parse({
      id: "ext",
      displayName: "Ext",
      contributes: {},
    });
    expect(result.contributes?.sidebarPanels).toBeUndefined();
    expect(result.contributes?.settings).toBeUndefined();
  });

  test("contributes with empty arrays", () => {
    const result = ExtensionManifestSchema.parse({
      id: "ext",
      displayName: "Ext",
      contributes: { sidebarPanels: [], settings: [] },
    });
    expect(result.contributes?.sidebarPanels).toEqual([]);
    expect(result.contributes?.settings).toEqual([]);
  });

  test("activationEvents default is overridden when provided", () => {
    const result = ExtensionManifestSchema.parse({
      id: "ext",
      displayName: "Ext",
      activationEvents: ["onStartup"],
    });
    expect(result.activationEvents).toEqual(["onStartup"]);
  });
});

// ============================================================
// ExtensionContributesSchema
// ============================================================

test.describe("ExtensionContributesSchema", () => {
  test("both fields optional", () => {
    const result = ExtensionContributesSchema.parse({});
    expect(result.sidebarPanels).toBeUndefined();
    expect(result.settings).toBeUndefined();
  });

  test("rejects invalid nested setting", () => {
    expect(() =>
      ExtensionContributesSchema.parse({
        settings: [{ id: "x" }], // missing type, default, title
      }),
    ).toThrow();
  });
});
