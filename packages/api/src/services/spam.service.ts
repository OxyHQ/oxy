/**
 * Spam Filtering Service
 *
 * Integrates with Rspamd via its HTTP API to score incoming messages.
 * Falls back gracefully when Rspamd is unavailable.
 */

import { SPAM_CONFIG } from '../config/email.config';
import { logger } from '../utils/logger';

export interface SpamResult {
  score: number;
  action: 'no action' | 'greylist' | 'add header' | 'rewrite subject' | 'soft reject' | 'reject';
  isSpam: boolean;
  symbols?: Record<string, { score: number; description?: string }>;
}

class SpamService {
  private readonly baseUrl: string;
  private readonly spamThreshold: number;
  private readonly rejectThreshold: number;
  private available = true;

  constructor() {
    this.baseUrl = SPAM_CONFIG.rspamdUrl;
    this.spamThreshold = SPAM_CONFIG.spamThreshold;
    this.rejectThreshold = SPAM_CONFIG.rejectThreshold;
  }

  /**
   * Check a raw email message against Rspamd.
   * Returns a score and recommended action.
   */
  async check(rawMessage: string | Buffer): Promise<SpamResult> {
    if (!SPAM_CONFIG.enabled || !this.available) {
      return { score: 0, action: 'no action', isSpam: false };
    }

    try {
      const response = await fetch(`${this.baseUrl}/checkv2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: typeof rawMessage === 'string' ? rawMessage : new Uint8Array(rawMessage),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        logger.warn('Rspamd returned non-OK status', { status: response.status });
        return { score: 0, action: 'no action', isSpam: false };
      }

      const data = (await response.json()) as {
        score?: number;
        action?: string;
        symbols?: Record<string, { score: number; description?: string }>;
      };

      const score = data.score ?? 0;
      const action = (data.action ?? 'no action') as SpamResult['action'];
      const isSpam = score >= this.spamThreshold;

      return { score, action, isSpam, symbols: data.symbols };
    } catch (error) {
      // If Rspamd is down, mark it unavailable and retry periodically
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('ECONNREFUSED'))
      ) {
        this.available = false;
        this.scheduleAvailabilityCheck();
        logger.warn('Rspamd unavailable, spam filtering disabled temporarily');
      } else {
        logger.error('Spam check error', error instanceof Error ? error : new Error(String(error)));
      }
      return { score: 0, action: 'no action', isSpam: false };
    }
  }

  /**
   * Whether the message score warrants outright rejection.
   */
  shouldReject(score: number): boolean {
    return score >= this.rejectThreshold;
  }

  /**
   * Periodically re-check if Rspamd is reachable.
   */
  private scheduleAvailabilityCheck(): void {
    setTimeout(async () => {
      try {
        const res = await fetch(`${this.baseUrl}/ping`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) {
          this.available = true;
          logger.info('Rspamd is available again');
        } else {
          this.scheduleAvailabilityCheck();
        }
      } catch {
        this.scheduleAvailabilityCheck();
      }
    }, 60_000);
  }
}

export const spamService = new SpamService();
export default spamService;
