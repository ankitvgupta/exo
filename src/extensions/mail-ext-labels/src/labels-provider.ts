import type {
  ExtensionContext,
  EnrichmentProvider,
  EnrichmentData,
} from "../../../shared/extension-types";
import type { DashboardEmail } from "../../../shared/types";
import { getClient } from "../../../main/ipc/gmail.ipc";

export interface LabelInfo {
  id: string;
  name: string;
  type: string;
  color?: { textColor: string; backgroundColor: string };
}

// In-memory cache: accountId -> (labelId -> LabelInfo)
const labelCache = new Map<string, Map<string, LabelInfo>>();

// System labels that the UI already shows via other means (inbox badge, unread styling, etc.)
const HIDDEN_SYSTEM_LABELS = new Set([
  "INBOX",
  "UNREAD",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "IMPORTANT",
  "STARRED",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "CATEGORY_PROMOTIONS",
]);

async function fetchAndCacheLabels(
  accountId: string,
  logger: ExtensionContext["logger"],
): Promise<Map<string, LabelInfo>> {
  try {
    const client = await getClient(accountId);
    const labels = await client.listLabels();
    const map = new Map<string, LabelInfo>();
    for (const label of labels) {
      map.set(label.id, label);
    }
    labelCache.set(accountId, map);
    logger.info(`Cached ${labels.length} labels for account ${accountId}`);
    return map;
  } catch (error) {
    logger.error("Failed to fetch labels:", error);
    return new Map();
  }
}

export function createLabelsProvider(context: ExtensionContext): EnrichmentProvider {
  return {
    id: "labels-provider",
    panelId: "email-labels",
    priority: 90,

    canEnrich(_email: DashboardEmail): boolean {
      // Always show the labels panel — even unlabeled emails need the "Add label" button
      return true;
    },

    async enrich(email: DashboardEmail): Promise<EnrichmentData | null> {
      const labelIds = email.labelIds;
      if (!labelIds?.length) return null;

      const accountId = email.accountId || "default";

      // Get or fetch label metadata
      let labelMap = labelCache.get(accountId);
      if (!labelMap) {
        labelMap = await fetchAndCacheLabels(accountId, context.logger);
      }

      // Resolve label IDs to full label info, filtering out system labels the UI already shows
      const resolvedLabels: LabelInfo[] = [];
      for (const id of labelIds) {
        if (HIDDEN_SYSTEM_LABELS.has(id)) continue;
        const info = labelMap.get(id);
        if (info) {
          resolvedLabels.push(info);
        } else {
          // Label not in cache — show the raw ID as a fallback
          resolvedLabels.push({ id, name: id, type: "unknown" });
        }
      }

      // Sort: user labels first (alphabetically), then system labels
      resolvedLabels.sort((a, b) => {
        if (a.type === "user" && b.type !== "user") return -1;
        if (a.type !== "user" && b.type === "user") return 1;
        return a.name.localeCompare(b.name);
      });

      return {
        extensionId: "labels",
        panelId: "email-labels",
        data: {
          labels: resolvedLabels,
          allLabelIds: labelIds,
        } as unknown as Record<string, unknown>,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
      };
    },
  };
}
