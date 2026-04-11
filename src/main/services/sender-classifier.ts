import type { SenderType } from "../../shared/types";

/**
 * Heuristic sender classification based on email headers.
 * Returns "automated" for obvious non-person senders,
 * or null when ambiguous (let the LLM decide).
 */
export function classifySenderByHeuristics(headers: {
  from: string;
  listUnsubscribe?: string;
  xMailer?: string;
  precedence?: string;
}): SenderType | null {
  const from = headers.from.toLowerCase();

  // noreply / do-not-reply addresses
  if (/\b(noreply|no-reply|donotreply|do-not-reply|no_reply)\b/.test(from)) {
    return "automated";
  }

  // List-Unsubscribe header = bulk/marketing email
  if (headers.listUnsubscribe) {
    return "automated";
  }

  // Precedence: bulk or list
  if (headers.precedence) {
    const prec = headers.precedence.toLowerCase();
    if (prec === "bulk" || prec === "list") {
      return "automated";
    }
  }

  // Known bulk email platform x-mailer headers
  if (headers.xMailer) {
    const mailer = headers.xMailer.toLowerCase();
    if (
      /mailchimp|sendgrid|mailgun|constantcontact|postmark|mandrill|sendinblue|brevo|hubspot|marketo|pardot|campaign.monitor|intercom|customer\.io/.test(
        mailer,
      )
    ) {
      return "automated";
    }
  }

  // Known automated sender domains
  const automatedDomains = [
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "linear.app",
    "atlassian.net",
    "jira.com",
    "slack.com",
    "notion.so",
    "figma.com",
    "calendar-notification",
    "google.com", // calendar notifications etc. (not GSuite user emails)
    "linkedin.com",
    "twitter.com",
    "facebook.com",
    "facebookmail.com",
    "instagram.com",
  ];

  // Extract domain from email address
  const domainMatch = from.match(/@([^\s>]+)/);
  if (domainMatch) {
    const domain = domainMatch[1];
    for (const d of automatedDomains) {
      if (domain === d || domain.endsWith("." + d)) {
        return "automated";
      }
    }

    // Subdomain patterns that indicate automated senders
    // e.g. notifications.pge.com, alerts.chase.com, mailer.spotify.com
    const automatedSubdomains =
      /^(notifications?|alerts?|mailer|mail|bounce|email|updates?|info|news|newsletter|marketing|promo|campaigns?|transactional|system|service|support|billing|receipts?|orders?)\./;
    if (automatedSubdomains.test(domain)) {
      return "automated";
    }
  }

  // Local part patterns that indicate automated senders
  // e.g. customerservice@, support@, info@, newsletter@
  const localMatch = from.match(/([^<\s]+)@/);
  if (localMatch) {
    const local = localMatch[1].toLowerCase();
    if (
      /^(customerservice|customer-service|customer_service|support|info|newsletter|news|marketing|billing|sales|admin|system|automated|robot|bot|notifications?|alerts?|updates?)$/.test(
        local,
      )
    ) {
      return "automated";
    }
  }

  // Ambiguous — let the LLM decide
  return null;
}
