/**
 * AI Email Labeling Service
 *
 * Classifies incoming emails using the Alia AI API and applies matching labels.
 * Runs through a bounded background queue after message storage — never blocks email delivery.
 *
 * ## Two Postgres details this file cannot get wrong
 *
 * **`messages.text` is a PROTECTED column** (`schema/protectedColumns.ts`): it
 * was `select: false` in Mongoose, and `db.select().from(messages)` would hand
 * it back. The classifier genuinely needs the body, so it is named EXPLICITLY in
 * the projection below — the sanctioned opt-in, which reads differently from an
 * ordinary select on purpose. Nothing read here reaches a response.
 *
 * **`labels` is a `text[]`, and `$addToSet` is not `||`.** Appending blindly
 * would duplicate a label the message already carries, which the Mongo operator
 * never did. The update rebuilds the array: existing entries in their existing
 * order, then each new one that is not already present, in the order the
 * classifier returned them.
 */

import axios from 'axios';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { labels as labelsTable } from '../db/schema/labels';
import { messages } from '../db/schema/messages';
import { SYSTEM_LABELS, isSystemLabel } from '../constants/systemLabels';
import { AI_LABELING_CONFIG } from '../config/email.config';
import { logger } from '../utils/logger';

const ALIA_BASE_URL = 'https://api.alia.onl/v1';
const ALIA_API_KEY = process.env.ALIA_API_KEY;

class AiLabelingService {
  private activeJobs = 0;
  private readonly queue: Array<{ userId: string; messageId: string }> = [];
  private processingScheduled = false;

  /**
   * Enqueue background AI labeling with bounded concurrency/backpressure.
   * Returns false when labeling is disabled or the queue is full.
   */
  enqueueClassification(userId: string, messageId: string): boolean {
    if (!AI_LABELING_CONFIG.enabled || !ALIA_API_KEY) {
      return false;
    }

    if (this.queue.length >= AI_LABELING_CONFIG.maxQueueSize) {
      logger.warn('AI labeling queue full; dropping classification job', {
        messageId,
        maxQueueSize: AI_LABELING_CONFIG.maxQueueSize,
      });
      return false;
    }

    this.queue.push({ userId, messageId });
    this.scheduleProcessing();
    return true;
  }

  private scheduleProcessing(): void {
    if (this.processingScheduled) {
      return;
    }

    this.processingScheduled = true;
    queueMicrotask(() => {
      this.processingScheduled = false;
      this.processQueue();
    });
  }

  private processQueue(): void {
    while (
      this.activeJobs < AI_LABELING_CONFIG.maxConcurrent &&
      this.queue.length > 0
    ) {
      const job = this.queue.shift();
      if (!job) {
        return;
      }

      this.activeJobs += 1;
      this.classifyAndLabel(job.userId, job.messageId)
        .catch((error) => {
          logger.warn('AI labeling failed', {
            messageId: job.messageId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.activeJobs -= 1;
          this.scheduleProcessing();
        });
    }
  }

  /**
   * Classify a message and apply labels.
   * Fire-and-forget — failures are logged, never thrown.
   */
  async classifyAndLabel(userId: string, messageId: string): Promise<void> {
    try {
      if (!AI_LABELING_CONFIG.enabled || !ALIA_API_KEY) {
        return;
      }

      const db = getDb();

      // The classifier chooses among the system labels plus whatever the user
      // has added. The system ones have no rows behind them, so querying the
      // table alone would leave a user who never made a label with nothing to
      // classify into.
      const custom = await db
        .select({ name: labelsTable.name })
        .from(labelsTable)
        .where(eq(labelsTable.userId, userId));
      const labelNames = [
        ...SYSTEM_LABELS.map((l) => l.name),
        ...custom.map((l) => l.name).filter((name) => !isSystemLabel(name)),
      ];
      if (labelNames.length === 0) return;

      // Fetch message content for classification. `text` is PROTECTED and is
      // named here deliberately — see the module header. `to` was in the Mongo
      // projection and used by nothing; it is a child table now
      // (`message_recipients`) and is not fetched.
      const [message] = await db
        .select({
          subject: messages.subject,
          fromName: messages.fromName,
          fromAddress: messages.fromAddress,
          text: messages.text,
        })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
        .limit(1);
      if (!message) return;

      const textPreview = (message.text || '').slice(0, AI_LABELING_CONFIG.maxBodyChars);
      const fromStr = `${message.fromName || ''} <${message.fromAddress}>`.trim();

      const { system, user } = this.buildPrompt(labelNames, {
        from: fromStr,
        subject: message.subject,
        body: textPreview,
      });

      const response = await axios.post(
        `${ALIA_BASE_URL}/chat/completions`,
        {
          model: AI_LABELING_CONFIG.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 100,
          temperature: 0.1,
          stream: false,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ALIA_API_KEY}`,
          },
          timeout: AI_LABELING_CONFIG.timeout,
        },
      );

      const content = response.data?.choices?.[0]?.message?.content || '';
      const assignedLabels = this.parseLabels(content, labelNames);

      if (assignedLabels.length > 0) {
        // `$addToSet` with `$each` adds each DISTINCT value once and skips any
        // the array already holds. Both halves are reproduced: duplicates within
        // the classifier's answer are collapsed here, and the SQL below appends
        // only what is missing — existing entries keep their order, new ones
        // follow in the order they were returned.
        const additions = [...new Set(assignedLabels)];
        const incoming = sql`array[${sql.join(
          additions.map((name) => sql`${name}`),
          sql`, `,
        )}]::text[]`;

        await getDb()
          .update(messages)
          .set({
            labels: sql`(
              select coalesce(array_agg(entry.label order by entry.bucket, entry.idx), '{}'::text[])
              from (
                  select kept.label, 0 as bucket, kept.idx
                  from unnest(${messages.labels}) with ordinality as kept(label, idx)
                union all
                  select added.label, 1 as bucket, added.idx
                  from unnest(${incoming}) with ordinality as added(label, idx)
                  where added.label <> all(${messages.labels})
              ) as entry
            )`,
          })
          .where(and(eq(messages.id, messageId), eq(messages.userId, userId)));
        logger.info('AI labels applied', { messageId, labels: assignedLabels });
      }
    } catch (error) {
      // Never throw — this is fire-and-forget
      logger.warn('AI labeling failed', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildPrompt(
    labelNames: string[],
    email: { from: string; subject: string; body: string },
  ) {
    return {
      system:
        'You are an email classifier. Given an email and a list of available labels, determine which labels apply. ' +
        'Respond with ONLY a JSON array of matching label names. Use only labels from the provided list. ' +
        'Apply 1-2 labels that best fit. If no labels clearly match, respond with an empty array []. ' +
        'Never invent labels outside the list.',
      user:
        `Available labels: ${JSON.stringify(labelNames)}\n\n` +
        `Email:\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${email.body}\n\n` +
        'Which labels apply? Respond with a JSON array only.',
    };
  }

  private parseLabels(aiResponse: string, validLabels: string[]): string[] {
    try {
      // Extract JSON array from response (handle markdown code blocks)
      const jsonMatch = aiResponse.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      // Validate against actual labels (case-insensitive match)
      const validSet = new Map(validLabels.map((l) => [l.toLowerCase(), l]));
      return parsed
        .filter((item: unknown): item is string => typeof item === 'string')
        .map((item: string) => validSet.get(item.toLowerCase()))
        .filter((name): name is string => !!name);
    } catch {
      return [];
    }
  }
}

export const aiLabelingService = new AiLabelingService();
