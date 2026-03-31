/**
 * OpenClaw agent provider types.
 *
 * OpenClaw CLI (`openclaw agent --json`) returns a structured JSON response.
 * These types model both the provider configuration and the CLI output shape.
 */

import { z } from "zod";

// --- Provider configuration (passed from settings) ---

export interface OpenClawProviderConfig {
  enabled: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
}

// --- CLI response shape (`openclaw agent --json`) ---

const OpenClawAgentPayloadSchema = z.object({
  text: z.string().nullable(),
  mediaUrl: z.string().nullable(),
});

const OpenClawAgentResultSchema = z.object({
  payloads: z.array(OpenClawAgentPayloadSchema).optional(),
  meta: z
    .object({
      durationMs: z.number(),
      agentMeta: z
        .object({
          sessionId: z.string(),
          provider: z.string(),
          model: z.string(),
          usage: z
            .object({
              input: z.number(),
              output: z.number(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export const OpenClawAgentResponseSchema = z.object({
  runId: z.string(),
  status: z.string(),
  summary: z.string(),
  result: OpenClawAgentResultSchema.optional(),
});

export type OpenClawAgentResponse = z.infer<typeof OpenClawAgentResponseSchema>;
