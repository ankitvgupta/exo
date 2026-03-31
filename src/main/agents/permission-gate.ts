import { type ToolDefinition, ToolRiskLevel } from "./tools/types";

export type PermissionDecision =
  | { action: "auto"; tier: 0 }
  | { action: "notify"; tier: 1; message: string }
  | { action: "confirm"; tier: 2; description: string }
  | {
      action: "confirm_preview";
      tier: 3;
      description: string;
      previewData: unknown;
    };

export class PermissionGate {
  checkPermission(tool: ToolDefinition, input: unknown): PermissionDecision {
    switch (tool.riskLevel) {
      case ToolRiskLevel.NONE:
        return { action: "auto", tier: 0 };

      case ToolRiskLevel.LOW:
        return {
          action: "notify",
          tier: 1,
          message: `${tool.name}: ${tool.description}`,
        };

      case ToolRiskLevel.MEDIUM:
        return {
          action: "confirm",
          tier: 2,
          description: formatConfirmation(tool, input),
        };

      case ToolRiskLevel.HIGH:
        return {
          action: "confirm_preview",
          tier: 3,
          description: formatConfirmation(tool, input),
          previewData: input,
        };
    }
  }
}

function formatConfirmation(tool: ToolDefinition, input: unknown): string {
  const inputObj = input as Record<string, unknown> | null;
  switch (tool.name) {
    case "create_draft":
      return `Create a draft reply to email ${inputObj?.emailId ?? "unknown"}`;
    default:
      return `Execute ${tool.name}`;
  }
}
