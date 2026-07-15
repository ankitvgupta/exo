/**
 * Unit tests for resolveBackgroundAgentProviderId — which agent provider runs
 * the automatic new-email drafter and the "Regenerate draft" rerun path.
 *
 * Pure config-resolution tests — no DB, mocks, or native modules needed.
 */
import { test, expect } from "@playwright/test";
import {
  ConfigSchema,
  DEFAULT_BACKGROUND_AGENT_PROVIDER,
  resolveBackgroundAgentProviderId,
} from "../../src/shared/types";

test.describe("ConfigSchema backgroundAgentProvider", () => {
  test("parses config with backgroundAgentProvider set", () => {
    const result = ConfigSchema.parse({ backgroundAgentProvider: "hostler" });
    expect(result.backgroundAgentProvider).toBe("hostler");
  });

  test("parses config without backgroundAgentProvider (undefined, resolver defaults to claude)", () => {
    const result = ConfigSchema.parse({});
    expect(result.backgroundAgentProvider).toBeUndefined();
  });
});

test.describe("resolveBackgroundAgentProviderId", () => {
  test("defaults to claude when unset", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: undefined,
      opencode: undefined,
      hostler: undefined,
    });
    expect(result).toBe(DEFAULT_BACKGROUND_AGENT_PROVIDER);
  });

  test("returns claude when explicitly selected", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "claude",
      opencode: { enabled: true },
      hostler: { enabled: true, apiKey: "cpk_123", harness: "opencode" },
    });
    expect(result).toBe("claude");
  });

  test("returns opencode when selected and enabled", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "opencode",
      opencode: { enabled: true },
      hostler: undefined,
    });
    expect(result).toBe("opencode");
  });

  test("falls back to claude when opencode selected but disabled", () => {
    // Disabling a provider must not strand background drafts on a dead
    // provider — they'd fail on every new email until the user also fixed
    // this setting.
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "opencode",
      opencode: { enabled: false },
      hostler: undefined,
    });
    expect(result).toBe("claude");
  });

  test("falls back to claude when opencode selected but config missing", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "opencode",
      opencode: undefined,
      hostler: undefined,
    });
    expect(result).toBe("claude");
  });

  test("returns hostler when selected, enabled, and keyed", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "hostler",
      opencode: undefined,
      hostler: { enabled: true, apiKey: "cpk_123", harness: "opencode" },
    });
    expect(result).toBe("hostler");
  });

  test("falls back to claude when hostler selected but disabled", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "hostler",
      opencode: undefined,
      hostler: { enabled: false, apiKey: "cpk_123", harness: "opencode" },
    });
    expect(result).toBe("claude");
  });

  test("falls back to claude when hostler selected but apiKey empty", () => {
    // Mirrors HostlerAgentProvider.isAvailable(): enabled && apiKey. An
    // enabled-but-keyless hostler would fail every run with an auth error.
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "hostler",
      opencode: undefined,
      hostler: { enabled: true, apiKey: "", harness: "opencode" },
    });
    expect(result).toBe("claude");
  });

  test("passes through unknown provider ids unchanged", () => {
    // Installed/private providers have config gates we can't see here — the
    // orchestrator fails explicitly for ids that aren't registered.
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "my-installed-provider",
      opencode: undefined,
      hostler: undefined,
    });
    expect(result).toBe("my-installed-provider");
  });
});
