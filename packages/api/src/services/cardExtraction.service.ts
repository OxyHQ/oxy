/**
 * Card Extraction Service
 *
 * Extracts structured data cards (trips, purchases, events, bills, packages)
 * and key highlights from incoming emails using the Alia AI API.
 * Runs as fire-and-forget after message storage — never blocks email delivery.
 *
 * ## What the Postgres port changed
 *
 * **The card is FOUR COLUMNS, not a sub-document.** `$set: { card: {...} }`
 * became `card_type` / `card_data` / `card_confidence` / `card_extracted_at`,
 * and the table carries `messages_card_complete_check` — a card is whole or
 * absent — so the four are written together or not at all. Nothing here may use
 * a dotted path: drizzle keys `set()` by column PROPERTY and silently ignores a
 * key naming no column, so `set({ 'card.type': … })` would write nothing and
 * throw nothing.
 *
 * **`messages.text` is PROTECTED** (`schema/protectedColumns.ts`) and is named
 * explicitly below because the extractor needs the body. `html` was in the Mongo
 * projection and read by nothing — it is another protected body, so it is no
 * longer fetched at all.
 *
 * **`attachments` is a child table.** Only its emptiness was ever used, so the
 * projection became an `EXISTS`, not a load of every attachment row.
 */

import axios from 'axios';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { qualified } from '@oxyhq/db';
import {
  MESSAGE_CARD_TYPES,
  messages,
  type MessageHighlight,
} from '../db/schema/messages';
import { messageAttachments } from '../db/schema/messageAttachments';
import { AI_LABELING_CONFIG } from '../config/email.config';
import { logger } from '../utils/logger';

const ALIA_BASE_URL = 'https://api.alia.onl/v1';
const ALIA_API_KEY = process.env.ALIA_API_KEY;

/** Bytes of message body handed to the extractor. */
const MAX_BODY_CHARS = 3000;

/** Minimum model confidence below which a card is discarded. */
const MIN_CARD_CONFIDENCE = 0.7;

/** Upstream request timeout, in milliseconds. */
const EXTRACTION_TIMEOUT_MS = 15000;

/** The structured card kinds the schema admits. */
type CardType = (typeof MESSAGE_CARD_TYPES)[number];

interface ExtractedCard {
  type: CardType;
  /** Genuinely shape-less — it differs per card type, which is why it is `jsonb`. */
  data: Record<string, unknown>;
  confidence: number;
}

interface ExtractionResult {
  card: ExtractedCard | null;
  highlights: MessageHighlight[];
}

class CardExtractionService {
  /**
   * Extract structured card data and highlights from a message.
   * Fire-and-forget — failures are logged, never thrown.
   */
  async extractAndUpdate(userId: string, messageId: string): Promise<void> {
    try {
      if (!ALIA_API_KEY) return;

      const db = getDb();
      const [message] = await db
        .select({
          subject: messages.subject,
          fromName: messages.fromName,
          fromAddress: messages.fromAddress,
          date: messages.date,
          // PROTECTED — named explicitly because the extractor reads the body.
          text: messages.text,
          // Only emptiness was ever used, so this asks the child table the one
          // question it is asked instead of loading every attachment row.
          // Both sides of the correlation are QUALIFIED: an unqualified pair
          // inside a subquery resolves against the subquery's own table and
          // silently answers a different question (`@oxyhq/db`'s casing module).
          hasAttachments: sql<boolean>`exists (
            select 1 from ${messageAttachments}
            where ${qualified(messageAttachments.messageId)} = ${qualified(messages.id)}
          )`,
        })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
        .limit(1);
      if (!message) return;

      const textContent = (message.text || '').slice(0, MAX_BODY_CHARS);
      if (!textContent && !message.subject) return;

      const fromStr = `${message.fromName || ''} <${message.fromAddress}>`.trim();

      const { system, user } = this.buildPrompt({
        from: fromStr,
        subject: message.subject,
        body: textContent,
        date: message.date.toISOString(),
        hasAttachments: message.hasAttachments,
      });

      const response = await axios.post(
        `${ALIA_BASE_URL}/chat/completions`,
        {
          model: AI_LABELING_CONFIG.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 800,
          temperature: 0.1,
          stream: false,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ALIA_API_KEY}`,
          },
          timeout: EXTRACTION_TIMEOUT_MS,
        },
      );

      const content = response.data?.choices?.[0]?.message?.content || '';
      const result = this.parseResult(content);

      if (!result.card && result.highlights.length === 0) return;

      // The four card columns move together or the row fails
      // `messages_card_complete_check`. Keys are column PROPERTIES; a dotted
      // path here would be dropped in silence.
      const update: Partial<typeof messages.$inferInsert> = {};
      if (result.card) {
        update.cardType = result.card.type;
        update.cardData = result.card.data;
        update.cardConfidence = result.card.confidence;
        update.cardExtractedAt = new Date();
      }
      if (result.highlights.length > 0) {
        update.highlights = result.highlights;
      }

      await db
        .update(messages)
        .set(update)
        .where(and(eq(messages.id, messageId), eq(messages.userId, userId)));
      logger.info('Card extraction complete', {
        messageId,
        cardType: result.card?.type ?? 'none',
        highlightCount: result.highlights.length,
      });
    } catch (error) {
      logger.warn('Card extraction failed', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildPrompt(email: {
    from: string;
    subject: string;
    body: string;
    date: string;
    hasAttachments: boolean;
  }) {
    return {
      system:
        'You are a structured data extractor for emails. Analyze the email and extract:\n' +
        '1. A "card" if the email contains actionable structured data. Card types:\n' +
        '   - "trip": flights, hotels, car rentals (fields: airline, flightNumber, departure, arrival, departureTime, arrivalTime, confirmationCode, hotel, checkIn, checkOut)\n' +
        '   - "purchase": order confirmations, receipts (fields: merchant, amount, currency, orderNumber, items, trackingUrl)\n' +
        '   - "event": calendar events, invitations (fields: title, startTime, endTime, location, organizer, rsvpUrl)\n' +
        '   - "bill": bills, invoices, payment due (fields: biller, amount, currency, dueDate, accountNumber, payUrl)\n' +
        '   - "package": shipping/delivery notifications (fields: carrier, trackingNumber, trackingUrl, estimatedDelivery, status, merchant)\n' +
        '2. "highlights": key data points (dates, prices, tracking numbers, confirmation codes, addresses)\n\n' +
        'Respond with ONLY valid JSON in this format:\n' +
        '{\n' +
        '  "card": { "type": "...", "data": { ... }, "confidence": 0.0-1.0 } | null,\n' +
        '  "highlights": [{ "type": "date|price|tracking|confirmation|address|phone|link", "value": "...", "label": "..." }]\n' +
        '}\n\n' +
        'Rules:\n' +
        '- Only create a card if confidence >= 0.7\n' +
        '- Include only fields that are actually present in the email\n' +
        '- For highlights, use short human-readable labels (e.g., "Due date", "Order total", "Tracking #")\n' +
        '- If the email is not transactional (e.g., newsletter, social, personal), return {"card": null, "highlights": []}\n' +
        '- Dates should be in ISO 8601 format when possible',
      user:
        `From: ${email.from}\n` +
        `Subject: ${email.subject}\n` +
        `Date: ${email.date}\n` +
        `Has attachments: ${email.hasAttachments}\n\n` +
        `Body:\n${email.body}`,
    };
  }

  private parseResult(aiResponse: string): ExtractionResult {
    const empty: ExtractionResult = { card: null, highlights: [] };
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return empty;

      const parsed = JSON.parse(jsonMatch[0]);

      let card: ExtractedCard | null = null;
      if (parsed.card && typeof parsed.card === 'object') {
        // The accepted set comes from the SCHEMA's own tuple, which is also what
        // types the column and generates `messages_card_type_check` — so a type
        // this parser lets through can never be one the table rejects.
        if (
          MESSAGE_CARD_TYPES.includes(parsed.card.type) &&
          typeof parsed.card.data === 'object' &&
          typeof parsed.card.confidence === 'number' &&
          parsed.card.confidence >= MIN_CARD_CONFIDENCE
        ) {
          card = {
            type: parsed.card.type,
            data: parsed.card.data,
            confidence: parsed.card.confidence,
          };
        }
      }

      const highlights: MessageHighlight[] = [];
      if (Array.isArray(parsed.highlights)) {
        for (const h of parsed.highlights) {
          if (
            h &&
            typeof h.type === 'string' &&
            typeof h.value === 'string' &&
            typeof h.label === 'string'
          ) {
            highlights.push({
              type: h.type,
              value: h.value,
              label: h.label,
            });
          }
        }
      }

      return { card, highlights };
    } catch {
      return empty;
    }
  }
}

export const cardExtractionService = new CardExtractionService();
