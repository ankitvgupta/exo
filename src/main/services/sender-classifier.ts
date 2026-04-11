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
  }

  // Ambiguous — let the LLM decide
  return null;
}
