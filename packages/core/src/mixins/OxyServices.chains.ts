/**
 * Chains — the shared record log every Oxy app reads and writes.
 *
 * A person has ONE chain. An app appends its own records to it and projects its
 * feeds from what it reads back, instead of keeping a private copy of the same
 * person's activity. This mixin is the client half of `/chains` in oxy-api, and
 * it exists so that adopting the chain costs an app no HTTP of its own — the
 * whole point of the shared substrate is that the second app writes less code
 * than the first, not the same amount in a different file.
 *
 * ## Both calls are SERVICE-authenticated
 *
 * They go through `makeServiceRequest`, so they only work on a backend that has
 * called `configureServiceAuth()`. That is not an accident of implementation: an
 * append writes to someone else's chain and a read spans many subjects, so
 * neither belongs in a browser holding a user session. A frontend that needs
 * this asks its own backend.
 *
 * The authority is checked server-side and cannot be talked out of from here:
 * `chains:write` plus the application's own `chainNamespaces` for an append,
 * `chains:read` plus the public-collection policy for a read. A call that
 * violates either gets a 403 or an empty page — this client adds no
 * pre-validation that could drift from the server's answer.
 */

import type { OxyServicesBase } from '../OxyServices.base';

/** A signed record as it comes back from a read. */
export interface ChainRecord<TRecord = Record<string, unknown>> {
  recordId: string;
  /** The subject whose chain it is — the person the record is about. */
  oxyUserId: string;
  /** The lexicon NSID, e.g. `app.mention.feed.post`. */
  collection: string;
  envelope: {
    version: number;
    type: string;
    subject: string;
    issuer: string;
    record: TRecord;
    issuedAt: number;
    seq?: number;
    prev?: string | null;
    collection?: string;
    rkey?: string;
    publicKey: string;
    alg: string;
    signature: string;
  };
}

/** One page of a multi-subject read. */
export interface ChainRecordPage<TRecord = Record<string, unknown>> {
  records: ChainRecord<TRecord>[];
  /**
   * Opaque. Hand it back as `since` to continue; `null` at the end of the
   * stream as of this snapshot. Never construct one.
   */
  nextCursor: string | null;
}

/** What an append returns once the record is on the chain. */
export interface AppendedChainRecord {
  recordId: string;
  seq: number;
  envelope: ChainRecord['envelope'];
  verified: boolean;
}

export function OxyServicesChainsMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /** Service-token request, implemented by the auth mixin earlier in the pipeline. */
    declare makeServiceRequest: <R = unknown>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      data?: unknown,
      userId?: string,
    ) => Promise<R>;

    /**
     * Append a record to `oxyUserId`'s chain under `collection`/`rkey`.
     *
     * Oxy issues and signs it; the calling app never holds a chain signing key.
     * `rkey` is the app's own id for the thing — reusing it later supersedes the
     * earlier record for that key, which is how an edit works.
     *
     * Requires the `chains:write` scope AND `collection` falling under one of
     * this application's granted `chainNamespaces`. Both are enforced by the
     * server; a violation throws with a 403.
     */
    async appendChainRecord(params: {
      oxyUserId: string;
      collection: string;
      rkey: string;
      record: Record<string, unknown>;
    }): Promise<AppendedChainRecord> {
      return this.makeServiceRequest<AppendedChainRecord>('POST', '/chains/records', params);
    }

    /**
     * Records published by any of `oxyUserIds` under any of `collections`,
     * oldest first — the read a cross-app feed is projected from.
     *
     * Only collections Oxy declares PUBLIC come back, whatever is asked for; a
     * private one yields nothing rather than an error.
     *
     * **Re-poll from slightly BEFORE your last cursor and dedupe by
     * `recordId`.** The chain's pagination axis is a transaction-start
     * timestamp, so a record can commit behind a cursor that already passed it.
     * Re-delivering one costs bytes; skipping one costs a record that never
     * appears. Projections are expected to be idempotent for exactly this
     * reason.
     */
    async readChainRecords<TRecord = Record<string, unknown>>(params: {
      oxyUserIds: readonly string[];
      collections: readonly string[];
      since?: string | null;
      limit?: number;
    }): Promise<ChainRecordPage<TRecord>> {
      const query = new URLSearchParams({
        authors: params.oxyUserIds.join(','),
        collections: params.collections.join(','),
      });
      if (params.since) query.set('since', params.since);
      if (params.limit !== undefined) query.set('limit', String(params.limit));

      return this.makeServiceRequest<ChainRecordPage<TRecord>>('GET', `/chains/records?${query.toString()}`);
    }
  };
}
