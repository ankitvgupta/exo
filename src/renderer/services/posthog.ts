import posthog from "posthog-js";
import { getAppStateSnapshot } from "../store";

// Runtime config includes the baked-in apiKey/host (from env vars)
// plus user-toggleable enabled/sessionReplay (from persisted settings).
interface PostHogConfig {
  enabled: boolean;
  apiKey: string;
  host: string;
  sessionReplay?: boolean;
}

let initialized = false;

// --- Pending queue ---
// Queues identify/track calls that arrive before PostHog is initialized.
// Flushed when initPostHog completes.
const pendingCalls: Array<() => void> = [];

// --- Last identity ---
// Stored so reconfigurePostHog can re-identify the user after reset().
let lastIdentifiedEmail: string | null = null;
let lastIdentifiedProps: Record<string, string | number | boolean> | undefined;

// --- Breadcrumb ring buffer ---
// Stores recent log entries in memory. Only flushed to PostHog on exception.

interface Breadcrumb {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

const BREADCRUMB_LEVELS: Record<string, Breadcrumb["level"]> = {
  log: "info",
  warn: "warn",
  error: "error",
  info: "info",
  debug: "debug",
};

const MAX_BREADCRUMBS = 100;
const breadcrumbs: Breadcrumb[] = [];

// --- Safe serialization ---
// JSON.stringify throws on circular references (DOM nodes, Error.cause chains,
// React fibers). console.log must never throw — it violates a fundamental contract.

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value instanceof Error) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// --- Console interception ---
// Captures recent console output into the breadcrumb buffer so that when an
// exception fires we have the full log trail without sending anything until then.

let consoleIntercepted = false;

function interceptConsole(): void {
  if (consoleIntercepted) return;
  consoleIntercepted = true;

  const levels = ["log", "warn", "error", "info", "debug"] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      // Don't collect breadcrumbs when PostHog is disabled
      if (!initialized) return;
      // Avoid infinite recursion from our own breadcrumb logs
      const msg = args.map(safeStringify).join(" ");
      if (msg.includes("[PostHog:breadcrumb]")) return;
      const entry: Breadcrumb = {
        timestamp: Date.now(),
        level: BREADCRUMB_LEVELS[level],
        message: msg.slice(0, 1000),
      };
      breadcrumbs.push(entry);
      if (breadcrumbs.length > MAX_BREADCRUMBS) {
        breadcrumbs.shift();
      }
    };
  }
}

/**
 * Add a breadcrumb to the ring buffer. Not sent to PostHog unless an exception occurs.
 */
export function addBreadcrumb(
  level: Breadcrumb["level"],
  message: string,
  data?: Record<string, unknown>,
): void {
  // Don't collect breadcrumbs when PostHog is disabled — prevents
  // data accumulated during opt-out from being flushed on re-enable.
  if (!initialized) return;
  const entry: Breadcrumb = { timestamp: Date.now(), level, message, data };
  breadcrumbs.push(entry);
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.shift();
  }
  console.log(`[PostHog:breadcrumb] [${level}] ${message}`, data ?? "");
}

// --- Environment snapshot collection ---

function collectPerformanceSnapshot(): Record<string, unknown> {
  const perf: Record<string, unknown> = {};
  try {
    // Memory (Chrome/Electron only)
    const mem = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
      }
    ).memory;
    if (mem) {
      perf.memory_used_mb = Math.round(mem.usedJSHeapSize / 1024 / 1024);
      perf.memory_total_mb = Math.round(mem.totalJSHeapSize / 1024 / 1024);
      perf.memory_limit_mb = Math.round(mem.jsHeapSizeLimit / 1024 / 1024);
      perf.memory_usage_pct = Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
    }

    // Navigation timing
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav) {
      perf.page_load_ms = Math.round(nav.loadEventEnd - nav.startTime);
      perf.dom_interactive_ms = Math.round(nav.domInteractive - nav.startTime);
    }

    // Uptime
    perf.uptime_seconds = Math.round(performance.now() / 1000);

    // Recent long tasks (>50ms)
    const longTasks = performance.getEntriesByType("longtask");
    if (longTasks.length > 0) {
      perf.long_task_count = longTasks.length;
      const recent = longTasks.slice(-5);
      perf.recent_long_tasks = recent.map((t) => ({
        duration_ms: Math.round(t.duration),
        seconds_ago: Math.round((performance.now() - t.startTime) / 1000),
      }));
    }

    // Resource count
    const resources = performance.getEntriesByType("resource");
    perf.resource_count = resources.length;
    const failedResources = resources.filter(
      (r) =>
        (r as PerformanceResourceTiming).transferSize === 0 &&
        (r as PerformanceResourceTiming).decodedBodySize === 0,
    );
    if (failedResources.length > 0) {
      perf.failed_resource_count = failedResources.length;
      // Only send pathname to avoid leaking full URLs (which may contain tokens/query params)
      perf.failed_resources = failedResources.slice(-10).map((r) => {
        try {
          return new URL(r.name).pathname;
        } catch {
          return "[unparseable]";
        }
      });
    }
  } catch {
    perf.collection_error = "Failed to collect performance data";
  }
  return perf;
}

function collectDOMSnapshot(): Record<string, unknown> {
  const dom: Record<string, unknown> = {};
  try {
    dom.element_count = document.querySelectorAll("*").length;
    dom.visible_modals = document.querySelectorAll("[role=dialog], .modal, [class*=modal]").length;
    dom.visible_toasts = document.querySelectorAll(
      "[class*=toast], [class*=Toast], [role=alert]",
    ).length;

    const active = document.activeElement;
    if (active && active !== document.body) {
      dom.active_element = {
        tag: active.tagName.toLowerCase(),
        id: active.id || undefined,
        className: active.className ? String(active.className).slice(0, 200) : undefined,
        type: active instanceof HTMLInputElement ? active.type : undefined,
      };
    }

    dom.viewport_width = window.innerWidth;
    dom.viewport_height = window.innerHeight;
    dom.device_pixel_ratio = window.devicePixelRatio;
    dom.scroll_y = window.scrollY;
    dom.scroll_x = window.scrollX;
    dom.settings_panel_open =
      document.querySelector("[class*=SettingsPanel], [class*=settings]") !== null;

    const emailItems = document.querySelectorAll("[data-email-id]");
    dom.visible_email_items = emailItems.length;
  } catch {
    dom.collection_error = "Failed to collect DOM data";
  }
  return dom;
}

function collectAppStateSnapshot(): Record<string, unknown> {
  try {
    return getAppStateSnapshot();
  } catch {
    return { collection_error: "Failed to collect app state" };
  }
}

function collectNetworkSnapshot(): Record<string, unknown> {
  const net: Record<string, unknown> = {};
  try {
    net.online = navigator.onLine;

    const conn = (
      navigator as unknown as {
        connection?: {
          effectiveType?: string;
          downlink?: number;
          rtt?: number;
          saveData?: boolean;
        };
      }
    ).connection;
    if (conn) {
      net.effective_type = conn.effectiveType;
      net.downlink_mbps = conn.downlink;
      net.rtt_ms = conn.rtt;
      net.save_data = conn.saveData;
    }
  } catch {
    net.collection_error = "Failed to collect network data";
  }
  return net;
}

/**
 * Capture an exception and flush everything — breadcrumbs, app state, performance,
 * DOM, network. Re-entrancy guard prevents recursive capture (e.g. if snapshot
 * collection itself triggers an error handler).
 */
let capturing = false;

export function captureException(error: Error | string, extra?: Record<string, unknown>): void {
  if (!initialized) return;
  if (capturing) return; // prevent recursion
  capturing = true;

  try {
    const errorObj = typeof error === "string" ? new Error(error) : error;

    console.error("[PostHog] Capturing exception:", errorObj.message, safeStringify(extra ?? ""));

    const performanceData = collectPerformanceSnapshot();
    const domData = collectDOMSnapshot();
    const appState = collectAppStateSnapshot();
    const networkData = collectNetworkSnapshot();

    const now = Date.now();
    const formattedBreadcrumbs = breadcrumbs.map((b) => ({
      ...b,
      ms_ago: now - b.timestamp,
      time_iso: new Date(b.timestamp).toISOString(),
    }));

    // Use posthog.captureException — it produces the $exception_list property
    // that PostHog's Error Tracking UI requires, while still accepting our
    // custom properties as additional data.
    posthog.captureException(errorObj, {
      breadcrumbs: formattedBreadcrumbs,
      breadcrumb_count: formattedBreadcrumbs.length,

      app_state: appState,
      performance: performanceData,
      dom: domData,
      network: networkData,

      electron: {
        user_agent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        hardware_concurrency: navigator.hardwareConcurrency,
      },

      ...extra,
    });

    breadcrumbs.length = 0;
  } finally {
    capturing = false;
  }
}

// --- Global error handlers ---

let handlersInstalled = false;

function installGlobalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  window.addEventListener("error", (event) => {
    captureException(event.error ?? event.message, {
      source: "window.onerror",
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      event.reason instanceof Error
        ? event.reason
        : String(event.reason ?? "Unhandled promise rejection");
    captureException(reason, { source: "unhandledrejection" });
  });

  console.log("[PostHog] Global error handlers installed");
}

/**
 * Initialize PostHog analytics in the renderer process.
 *
 * Design: minimal data sent during normal operation. Autocapture is disabled.
 * Session replay captures DOM for visual debugging. On exception, we dump
 * everything — breadcrumbs, app state, performance, DOM, network — for
 * maximum debuggability.
 */
export function initPostHog(config: PostHogConfig): void {
  if (!config.enabled || !config.apiKey) {
    console.log("[PostHog] Skipping init — disabled or no API key");
    return;
  }

  console.log(
    "[PostHog] Initializing with host:",
    config.host || "https://us.i.posthog.com",
    "| session replay:",
    config.sessionReplay ?? false,
  );

  posthog.init(config.apiKey, {
    api_host: config.host || "https://us.i.posthog.com",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    persistence: "localStorage",
    enable_recording_console_log: false,
    disable_session_recording: !config.sessionReplay,
    session_recording: {
      maskAllInputs: true,
      // maskAllText is not available in this posthog-js version;
      // maskTextSelector: "*" achieves the same result.
      maskTextSelector: "*",
    },
  });

  interceptConsole();
  installGlobalHandlers();
  initialized = true;

  // Flush any identify/track calls that arrived before init completed
  for (const fn of pendingCalls) fn();
  pendingCalls.length = 0;

  console.log("[PostHog] Initialized (minimal mode — exceptions dump full context)");
}

// --- Hashing ---
// Hash email to a hex string so we never send raw PII as distinct_id.
async function hashEmail(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Identify the current user by a hashed version of their email.
 * The distinct_id is hashed, but we send the raw email as a person
 * property so it's visible in PostHog's UI (recordings list, etc.).
 */
export function identifyUser(
  email: string,
  properties?: Record<string, string | number | boolean>,
): void {
  if (!initialized) {
    pendingCalls.push(() => identifyUser(email, properties));
    return;
  }
  lastIdentifiedEmail = email;
  lastIdentifiedProps = properties;
  console.log("[PostHog] Identifying user: [hashed]");
  hashEmail(email)
    .then((hashedId) => {
      if (!initialized) return; // may have been shut down while hashing
      posthog.identify(hashedId, { email, ...properties });
    })
    .catch((err) => {
      console.warn("[PostHog] Failed to hash email for identify:", err);
    });
}

/**
 * Track a named event. Use sparingly — prefer addBreadcrumb for most things.
 */
export function trackEvent(
  event: string,
  properties?: Record<string, string | number | boolean | undefined>,
): void {
  // Don't queue track calls — stale events (e.g. app_launched hours later)
  // produce misleading analytics. Just drop them.
  if (!initialized) return;
  console.log("[PostHog] Event:", event);
  posthog.capture(event, properties);
}

export function resetIdentity(): void {
  if (!initialized) return;
  console.log("[PostHog] Resetting identity");
  posthog.reset();
}

export function shutdownPostHog(): void {
  if (!initialized) return;
  console.log("[PostHog] Shutting down");
  // Stop session recording explicitly before reset
  posthog.stopSessionRecording();
  // Use reset() instead of opt_out_capturing() — opt_out persists to localStorage
  // and would cause posthog.init() to silently drop all events on re-init.
  posthog.reset();
  initialized = false;
  // Clear breadcrumbs so data from the opted-in session can't leak
  // if the user later re-enables analytics.
  breadcrumbs.length = 0;
}

export function reconfigurePostHog(config: PostHogConfig): void {
  console.log("[PostHog] Reconfiguring — enabled:", config.enabled, "hasKey:", !!config.apiKey);

  if (!config.enabled || !config.apiKey) {
    // Disabling — shut down if running
    if (initialized) {
      shutdownPostHog();
    }
    return;
  }

  if (!initialized) {
    // First-time enable — normal init path
    initPostHog(config);
  }

  // Always explicitly set recording state — posthog.init() is a no-op after
  // the first call (even after reset()), so config options like
  // disable_session_recording are silently ignored on re-init.
  if (initialized) {
    if (config.sessionReplay) {
      posthog.startSessionRecording();
    } else {
      posthog.stopSessionRecording();
    }
  }

  // Re-identify user (reset() may have cleared distinct_id on prior shutdown)
  if (lastIdentifiedEmail) {
    hashEmail(lastIdentifiedEmail)
      .then((hashedId) => {
        if (!initialized) return; // may have been shut down while hashing
        posthog.identify(hashedId, { email: lastIdentifiedEmail, ...lastIdentifiedProps });
      })
      .catch((err) => {
        console.warn("[PostHog] Failed to hash email for re-identify:", err);
      });
  }
}

export function isPostHogActive(): boolean {
  return initialized;
}
