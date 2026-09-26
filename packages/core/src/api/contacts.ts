/**
 * `oxy.contacts` — privacy-preserving discovery of which address-book contacts
 * are on Oxy.
 *
 * Hash locally, send only digests; the server answers with the Oxy user ids
 * and the hashes that matched. Hashing must match the server
 * (`utils/contactHash.ts`): SHA-256, lowercase hex, over
 * - an email: `trim().toLowerCase()`;
 * - a phone: trim → keep one leading `+` → strip non-digits → prepend `+` if missing.
 */
import type { OxyContext } from '../client/context';

/** One contact that is on Oxy. */
export interface ContactDiscoveryMatch {
  /** The Oxy user id. */
  userId: string;
  /** The request hash that matched. */
  hashedIdentifier: string;
  matchType: 'email' | 'phone';
}

export interface ContactDiscoveryResponse {
  matches: ContactDiscoveryMatch[];
}

export class ContactsApi {
  constructor(protected readonly ctx: OxyContext) {}

  /**
   * Which of these hashed contacts are on Oxy. Either list may be empty, not
   * both; at most 200 hashes per list per call (batch larger books).
   */
  async discover(hashedEmails: string[], hashedPhones: string[]): Promise<ContactDiscoveryResponse> {
    return this.ctx.request<ContactDiscoveryResponse>(
      'POST',
      '/contacts/discover',
      { hashedEmails, hashedPhones },
      { cache: false },
    );
  }
}
