/**
 * Inbox realtime fan-out.
 *
 * One home for every `email:*` Socket.IO emit, called from the SERVICE layer —
 * never from a route. That placement is the point: the emit used to live in
 * `routes/emailInbound.ts`, so only mail arriving through the Cloudflare Email
 * Routing webhook reached a connected client. Every other ingest path — the
 * SMTP listener, `.eml` import, a filter-driven move, a snooze waking up, the
 * welcome message — stored a row and told nobody. Emitting from
 * `EmailService.storeIncomingMessage` covers all of them by construction.
 *
 * Every function here is best-effort and never throws: a webhook still has to
 * answer 200 to Cloudflare when Redis is unhealthy, and a user action still has
 * to succeed when the socket layer is down.
 */

import { and, eq, not, sql } from 'drizzle-orm';
import { normalizeInlineText } from '@oxy.so/core';
import { getDb } from '../config/postgres';
import { mailboxes } from '../db/schema/mailboxes';
import { messages } from '../db/schema/messages';
import { logger } from '../utils/logger';
import { getIO } from '../utils/socket';
import type {
  EmailChangedEvent,
  EmailChangedReason,
  EmailNewEvent,
  EmailUnreadCountEvent,
} from '../types/socketEvents';

const SNIPPET_MAX_LENGTH = 140;

/** One pass over the named entities this snippet cares about. */
const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
};

/**
 * Decode entities in a SINGLE pass.
 *
 * Chained `.replace()` calls double-unescape: decoding `&amp;` to `&` first
 * turns `&amp;lt;` into `&lt;`, which the next call then turns into `<`. The
 * sender controls that string, so the snippet would show markup they wrote as
 * an entity. One regex, one substitution per match, no second look.
 */
function decodeEntitiesOnce(input: string): string {
  return input.replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (match, name: string) => {
    const decoded = HTML_ENTITIES[name.toLowerCase()];
    return decoded === undefined ? match : decoded;
  });
}

/** Elements whose content is raw text, not markup, and must be dropped whole. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'title', 'textarea']);

/**
 * Remove markup from a body we are reducing to one line of preview text.
 *
 * A scanner rather than a regex, because the regex version is wrong in two ways
 * that matter and cannot be patched out of it:
 *
 *  - `<[^>]*>` stops at the first `>`, so `<a title="a>b">link</a>` leaves
 *    `b">link` in the preview. A `>` inside a quoted attribute is ordinary
 *    text, and only a scanner that tracks quoting knows that.
 *  - `<\/script>` is not the only valid end tag. `</script >`, `</script\n>`
 *    and `</SCRIPT  >` all close the element, and a pattern that misses them
 *    leaves the script BODY in the snippet — the sender's tracking code quoted
 *    back at the reader as if it were their message.
 *
 * This is preview text rendered into an RN `Text`, never into HTML, so it is
 * not an XSS sink. It is still wrong to show someone a stylesheet.
 */
function stripMarkup(html: string): string {
  let out = '';
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    // Comments, CDATA and doctypes end differently from tags.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      out += ' ';
      continue;
    }

    // A `<` only opens a tag when a name, a slash or a markup declaration
    // follows it. `5 < 6` is arithmetic, and a browser renders it as such;
    // treating it as a tag swallows everything up to the next `>`, which is
    // usually the end of the sentence.
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? '')) {
      out += '<';
      i = lt + 1;
      continue;
    }

    const tag = readTag(html, lt);
    if (!tag) {
      // An opening `<` that never closes: the remainder is markup we cannot
      // read, so drop it rather than quote it.
      break;
    }
    out += ' ';
    i = tag.end;

    if (!tag.closing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      i = skipRawText(html, i, tag.name);
    }
  }

  return out;
}

interface ScannedTag {
  name: string;
  closing: boolean;
  /** Index just past the tag's `>`. */
  end: number;
}

/**
 * Read one tag starting at `<`, honouring quoted attribute values so a `>`
 * inside one does not end the tag early. Returns null when it never closes.
 */
function readTag(html: string, start: number): ScannedTag | null {
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;

  const nameStart = i;
  while (i < html.length && /[a-zA-Z0-9:-]/.test(html[i])) i++;
  const name = html.slice(nameStart, i).toLowerCase();

  let quote: string | null = null;
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { name, closing, end: i + 1 };
    }
    i++;
  }
  return null;
}

/**
 * Skip to just past the end tag of a raw-text element. Whitespace between the
 * name and `>` is legal, which is exactly what the regex version missed.
 */
function skipRawText(html: string, from: number, name: string): number {
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return html.length;
    const tag = readTag(html, lt);
    if (tag && tag.closing && tag.name === name) return tag.end;
    i = tag ? tag.end : lt + 1;
  }
  return html.length;
}

/**
 * Build a short plain-text snippet from a message body. Prefers `text` when
 * present; otherwise strips tags and entities from `html` with a minimal
 * regex (no new dependency). The result has whitespace collapsed and is
 * trimmed to {@link SNIPPET_MAX_LENGTH} characters.
 */
export function buildSnippet(text?: string | null, html?: string | null): string {
  const source = text && text.trim().length > 0
    ? text
    : html
      ? decodeEntitiesOnce(stripMarkup(html))
      : '';
  // A snippet is a ONE-LINE preview of a message body written by a third party,
  // so the canonical inline normalizer applies: every line break the sender's
  // markup happened to contain becomes a space. (Clients render it in an RN
  // `Text`, which would otherwise preserve them.)
  const collapsed = normalizeInlineText(source);
  return collapsed.length > SNIPPET_MAX_LENGTH
    ? collapsed.slice(0, SNIPPET_MAX_LENGTH)
    : collapsed;
}

/**
 * Resolve the recipient's mailbox folder name for the socket payload. Falls
 * back to `'inbox'` for spam-routed deliveries so clients always receive a
 * meaningful folder hint without an extra round-trip.
 */
export function resolveFolder(
  specialUse: string | null | undefined,
  mailboxName: string | null | undefined,
): string {
  if (specialUse === '\\Junk') return 'spam';
  if (specialUse === '\\Inbox') return 'inbox';
  if (typeof mailboxName === 'string' && mailboxName.trim().length > 0) {
    return mailboxName.toLowerCase();
  }
  return 'inbox';
}

/** Count the unread messages in one mailbox. */
async function countUnread(mailboxId: string): Promise<number> {
  // The count `mailboxes.unseen_messages` used to cache. The partial index
  // `messages_unseen_idx` (`where not seen`) makes it an index-only scan over
  // just the unread rows.
  const [row] = await getDb()
    .select({ unread: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), not(messages.seen)));
  return row?.unread ?? 0;
}

export interface EmitEmailNewArgs {
  userId: string;
  /** The stored row's primary key. */
  id: string;
  /** The RFC 5322 `Message-Id` header. */
  messageId: string;
  mailboxId: string;
  receivedAt: Date | string;
  from: { name?: string; address: string };
  subject: string;
  text?: string | null;
  html?: string | null;
}

/**
 * Announce a freshly stored inbound message, then the authoritative unread
 * count for its mailbox. Failures are isolated and logged — the caller's write
 * has already committed and must not be undone by a dead socket layer.
 */
export async function emitEmailNew(args: EmitEmailNewArgs): Promise<void> {
  try {
    const io = getIO();
    if (!io) {
      logger.warn('Inbox socket emit skipped: Socket.IO not initialised');
      return;
    }
    if (!args.id) {
      logger.warn('Inbox socket emit skipped: stored message missing id');
      return;
    }

    const room = `user:${args.userId}`;

    const [mailbox] = await getDb()
      .select({ name: mailboxes.name, specialUse: mailboxes.specialUse })
      .from(mailboxes)
      .where(eq(mailboxes.id, args.mailboxId))
      .limit(1);

    const receivedAt = args.receivedAt instanceof Date
      ? args.receivedAt.toISOString()
      : new Date(args.receivedAt).toISOString();

    const payload: EmailNewEvent = {
      id: args.id,
      messageId: args.messageId,
      mailboxId: args.mailboxId,
      folder: resolveFolder(mailbox?.specialUse, mailbox?.name),
      from: args.from.name
        ? { name: args.from.name, address: args.from.address }
        : { address: args.from.address },
      subject: args.subject,
      snippet: buildSnippet(args.text, args.html),
      receivedAt,
      unread: true,
    };

    io.to(room).emit('email:new', payload);

    const unreadPayload: EmailUnreadCountEvent = {
      mailboxId: args.mailboxId,
      unread: await countUnread(args.mailboxId),
    };
    io.to(room).emit('email:unread_count', unreadPayload);
  } catch (err) {
    logger.warn('Inbox socket emit failed', {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Announce that a message a client already holds has changed, so a second
 * device converges without the user reloading. Carries no body — a client
 * answers by re-reading through its ordinary authorised HTTP path.
 *
 * Also re-emits the unread count for each affected mailbox, since every reason
 * here (`flags`, `moved`, `deleted`, …) can change it.
 */
export async function emitEmailChanged(args: {
  userId: string;
  id: string;
  mailboxIds: ReadonlyArray<string | null | undefined>;
  reason: EmailChangedReason;
}): Promise<void> {
  try {
    const io = getIO();
    if (!io) return;

    const mailboxIds = [...new Set(args.mailboxIds.filter((id): id is string => !!id))];
    const room = `user:${args.userId}`;

    const payload: EmailChangedEvent = {
      id: args.id,
      mailboxIds,
      reason: args.reason,
    };
    io.to(room).emit('email:changed', payload);

    for (const mailboxId of mailboxIds) {
      const unreadPayload: EmailUnreadCountEvent = {
        mailboxId,
        unread: await countUnread(mailboxId),
      };
      io.to(room).emit('email:unread_count', unreadPayload);
    }
  } catch (err) {
    logger.warn('Inbox change emit failed', {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
