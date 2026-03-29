import Anthropic from "@anthropic-ai/sdk";
import { stripJsonFences } from "../../shared/strip-json-fences";
import {
  DEFAULT_CALENDARING_PROMPT,
  DEFAULT_EA_DEFERRAL_TEMPLATE,
  type CalendaringResult,
  type EAConfig,
  type Email,
} from "../../shared/types";

export class CalendaringAgent {
  private anthropic: Anthropic;
  private model: string;
  private prompt: string;

  constructor(model: string = "claude-sonnet-4-20250514", prompt?: string) {
    this.anthropic = new Anthropic();
    this.model = model;
    this.prompt = prompt || DEFAULT_CALENDARING_PROMPT;
  }

  async analyze(email: Email): Promise<CalendaringResult> {
    const response = await this.anthropic.messages.create({
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
    });

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
      console.error("Failed to parse calendaring response:", textBlock.text);
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
