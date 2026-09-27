/**
 * The `Message-ID` a relay actually delivered a message under, when it is not
 * the one we wrote.
 *
 * Amazon SES's SMTP interface REPLACES the `Message-ID` header with its own,
 * `<{ses id}@{region}.amazonses.com>`, and answers the DATA command with
 * `250 Ok {ses id}`. Measured in production on 2026-09-27: a reply sent as
 * `<…@oxy.so>` arrived — at AWS support and back in the sender's own inbox —
 * as `<010101a0e167f1da-…-000000@us-west-2.amazonses.com>`, and AWS's answer
 * named that id in `In-Reply-To`. Unless the Sent row knows it, the answer
 * cannot find the conversation it belongs to.
 *
 * A relay that keeps our header (Postfix, Brevo) yields `null`: our own id is
 * already the one the world sees.
 */

/**
 * Our own Message-ID, stamped on every user message. Relays may replace the
 * `Message-ID` header (SES does); they carry custom headers through untouched,
 * so this is how a message that comes back to one of our users is recognised
 * as the copy of their Sent row.
 */
export const OXY_SENT_ID_HEADER = 'X-Oxy-Sent-Id';

/** `email-smtp.<region>.amazonaws.com` — the SES SMTP endpoint of one region. */
const SES_SMTP_HOST = /^email-smtp\.([a-z0-9-]+)\.amazonaws\.com$/i;

/** `250 Ok <ses id>`; the id is hex groups joined by dashes. */
const SES_ACCEPTED = /^250[ -]Ok ([0-9a-f]+(?:-[0-9a-f]+)+)\s*$/i;

export function relayAssignedMessageId(relayHost: string, smtpResponse: string | undefined): string | null {
  const region = SES_SMTP_HOST.exec(relayHost.trim())?.[1];
  if (!region || !smtpResponse) return null;
  const sesId = SES_ACCEPTED.exec(smtpResponse.trim())?.[1];
  return sesId ? `<${sesId}@${region.toLowerCase()}.amazonses.com>` : null;
}
