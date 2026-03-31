import { createMessage } from "./anthropic-service";
import { stripJsonFences } from "../../shared/strip-json-fences";
import {
  DEFAULT_CALENDARING_PROMPT,
  DEFAULT_EA_DEFERRAL_TEMPLATE,
  type CalendaringResult,
  type EAConfig,
  type Email,
} from "../../shared/types";
import { createLogger } from "./logger";

const log = createLogger("calendaring");

export class CalendaringAgent {
  private model: string;
  private prompt: string;

  constructor(model: string = "claude-sonnet-4-20250514", prompt?: string) {
    this.model = model;
    this.prompt = prompt || DEFAULT_CALENDARING_PROMPT;
  }

  async analyze(email: Email): Promise<CalendaringResult> {
    const response = await createMessage(
      {
        model: this.model,
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: `${this.prompt}

---
EMAIL TO ANALYZE:

From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date}

${email.body}`,
          },
        ],
      },
      { caller: "calendaring-agent", emailId: email.id },
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    try {
      const parsed = JSON.parse(stripJsonFences(textBlock.text));
      return {
        hasSchedulingContext: Boolean(parsed.hasSchedulingContext),
        action: parsed.action || "none",
        reason: parsed.reason || "",
      };
    } catch {
      // If JSON parsing fails, return a default
      log.error({ err: textBlock.text }, "Failed to parse calendaring response");
      return {
        hasSchedulingContext: false,
        action: "none",
        reason: "Failed to parse calendaring analysis",
      };
    }
  }

  generateEADeferralLanguage(eaConfig: EAConfig): string {
    if (!eaConfig.enabled || !eaConfig.email) {
      return "";
    }

    const template = DEFAULT_EA_DEFERRAL_TEMPLATE;
    return template
      .replace("{{EA_NAME}}", eaConfig.name || "my assistant")
      .replace("{{EA_EMAIL}}", eaConfig.email);
  }
}
