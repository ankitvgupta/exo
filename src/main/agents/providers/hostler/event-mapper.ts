import type { SessionEvent } from "@hostler/sdk";
import type { AgentEvent } from "../../types";

/**
 * Translate the Hostler session event log into the mail-app's AgentEvent shape.
 *
 * Unlike the OpenCode mapper, no session filtering is needed — Hostler's
 * events endpoint is per-session. The mapper is purely presentational: the
 * provider handles control flow (client-tool execution, idle/terminated
 * handling) by switching on the raw event alongside this mapper.
 *
 * Mapping shape:
 *   agent.message_delta            → text_delta
 *   agent.message                  → text_delta only if no deltas streamed for
 *                                    this message (some turns arrive without
 *                                    deltas); otherwise dedup-dropped
 *   agent.thinking_delta           → dropped (the mail-app doesn't surface
 *                                    reasoning in the UI; matches OpenCode)
 *   agent.tool_use                 → tool_call_start (all locales — sandbox
 *                                    and mcp tool activity is timeline-worthy)
 *   agent.tool_result              → tool_call_end
 *   session.error (retryable)      → dropped (the platform retries; surfacing
 *                                    it would flash transient noise in the UI)
 *   session.error (non-retryable)  → error
 *   session.status_idle (error)    → error (terminal message from stopReason)
 *   everything else                → dropped (user echoes, spans, status) —
 *                                    including unknown future event types,
 *                                    which Hostler documents as an open union
 */
export interface HostlerEventMapper {
  next(e: SessionEvent): AgentEvent[];
  /** Full text of the last agent.message seen — used for the `done` summary. */
  lastMessage(): string | null;
}

export function createHostlerEventMapper(): HostlerEventMapper {
  // Characters of message_delta emitted since the last agent.message boundary.
  // agent.message carries the full message text that the deltas already
  // streamed — emit it only when no deltas preceded it.
  let deltaChars = 0;
  let lastMessage: string | null = null;
  // The platform emits one client-tool call twice — once with locale
  // "sandbox" (the harness dispatching it) and once with locale "client"
  // (the park), same toolCallId — verified against the live pi harness.
  // Emit start/end exactly once per call (mirrors the OpenCode mapper).
  const startedTools = new Set<string>();
  const endedTools = new Set<string>();

  return {
    next(e: SessionEvent): AgentEvent[] {
      switch (e.type) {
        case "agent.message_delta":
          deltaChars += e.text.length;
          return [{ type: "text_delta", text: e.text }];

        case "agent.message": {
          lastMessage = e.text;
          const emitted = deltaChars > 0;
          deltaChars = 0;
          if (emitted) return [];
          return e.text.length > 0 ? [{ type: "text_delta", text: e.text }] : [];
        }

        case "agent.tool_use": {
          if (startedTools.has(e.toolCallId)) return [];
          startedTools.add(e.toolCallId);
          return [
            {
              type: "tool_call_start",
              toolName: e.name,
              toolCallId: e.toolCallId,
              input: e.input,
            },
          ];
        }

        case "agent.tool_result": {
          if (endedTools.has(e.toolCallId)) return [];
          endedTools.add(e.toolCallId);
          const text = e.content.map((c) => c.text).join("\n");
          return [
            {
              type: "tool_call_end",
              toolCallId: e.toolCallId,
              result: e.isError ? { error: text } : text,
            },
          ];
        }

        case "session.error":
          return e.retryable ? [] : [{ type: "error", message: e.message }];

        case "session.status_idle":
          if (e.stopReason.type === "error") {
            return [{ type: "error", message: e.stopReason.message }];
          }
          return [];

        default:
          return [];
      }
    },
    lastMessage: () => lastMessage,
  };
}
