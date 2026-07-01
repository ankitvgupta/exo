import type { AttachmentMeta, DashboardEmail } from "../../shared/types";
import { type AttachmentWithId, formatFileSize, hasAttachmentId } from "./attachments";

export type OpenableLink = {
  kind: "link";
  id: string;
  label: string;
  metadata: string;
  url: string;
};

export type OpenableAttachment = {
  kind: "attachment";
  id: string;
  label: string;
  metadata: string;
  attachment: AttachmentWithId;
};

export type OpenableItem = OpenableLink | OpenableAttachment;

export const MAX_RENDERED_OPENABLE_ITEMS = 100;

export function displayUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  const suffix = url.search || url.hash ? `${url.search}${url.hash}` : "";
  return `${url.hostname}${path}${suffix}`;
}

function normalizeLabel(label: string, fallback: string): string {
  const cleaned = label.replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function trimUrlCandidate(candidate: string): string {
  return candidate.replace(/[),.;!?]+$/g, "");
}

export function extractLinks(body: string): OpenableLink[] {
  if (!body.trim()) return [];

  const doc = new DOMParser().parseFromString(body, "text/html");
  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  const seen = new Set<string>();
  const links: OpenableLink[] = [];

  const addLink = (rawHref: string, labelText: string) => {
    if (!rawHref) return;

    const href = rawHref.trim();
    if (!href) return;

    const absoluteHref = href.startsWith("//") ? `https:${href}` : href;
    if (!/^https?:\/\//i.test(absoluteHref)) return;

    let url: URL;
    try {
      url = new URL(absoluteHref);
    } catch {
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (seen.has(url.href)) return;
    seen.add(url.href);

    links.push({
      kind: "link",
      id: `link:${url.href}`,
      label: normalizeLabel(labelText, displayUrl(url)),
      metadata: displayUrl(url),
      url: url.href,
    });
  };

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute("href");
    if (!rawHref) continue;

    const title = anchor.getAttribute("title") ?? "";
    const ariaLabel = anchor.getAttribute("aria-label") ?? "";
    const textLabel = normalizeLabel(anchor.textContent ?? "", "");
    addLink(rawHref, textLabel || title || ariaLabel);
  }

  const text = doc.body?.textContent ?? body;
  const urlMatches = text.matchAll(/https?:\/\/[^\s<>"']+/gi);
  for (const match of urlMatches) {
    const href = trimUrlCandidate(match[0]);
    addLink(href, href);
  }

  return links;
}

export function attachmentMetadata(attachment: AttachmentMeta): string {
  const parts = [formatFileSize(attachment.size)];
  if (attachment.mimeType) parts.push(attachment.mimeType);
  return parts.join(" - ");
}

export function buildOpenables(email: DashboardEmail | null): OpenableItem[] {
  if (!email) return [];

  const links = extractLinks(email.body ?? "");
  const attachments: OpenableAttachment[] = (email.attachments ?? [])
    .filter(hasAttachmentId)
    .map((attachment) => ({
      kind: "attachment",
      id: `attachment:${attachment.id}`,
      label: attachment.filename,
      metadata: attachmentMetadata(attachment),
      attachment,
    }));

  return [...links, ...attachments];
}

export function itemMatches(item: OpenableItem, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystack = [item.label, item.metadata, item.kind === "link" ? item.url : ""]
    .join(" ")
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}
