import { chainHeadResponseSchema, logPageResponseSchema, safeParseContract } from '../index';
import type {
  ChainHeadResponse,
  LexiconRecord,
  LogPageResponse,
  SignedRecordEnvelope,
} from '../index';

/**
 * The generic Oxy Protocol surface — the chain-wire shapes every chain store
 * shares (`ChainHeadResponse`, `LogPageResponse`) and the `LexiconRecord` typed
 * projection. Locking these here keeps the API handlers, the SDK mixins, and app
 * nodes from drifting.
 */
describe('chainHeadResponseSchema', () => {
  it('round-trips a populated head', () => {
    const head: ChainHeadResponse = {
      headRecordId: 'a'.repeat(64),
      seq: 3,
      recordCount: 4,
    };
    const parsed = safeParseContract(chainHeadResponseSchema, head);
    expect(parsed).toEqual(head);
  });

  it('round-trips an empty head (no chain yet: null / -1 / 0)', () => {
    const head: ChainHeadResponse = { headRecordId: null, seq: -1, recordCount: 0 };
    const parsed = safeParseContract(chainHeadResponseSchema, head);
    expect(parsed).toEqual(head);
    expect(parsed?.headRecordId).toBeNull();
    expect(parsed?.seq).toBe(-1);
  });

  it('rejects a negative recordCount', () => {
    const parsed = safeParseContract(chainHeadResponseSchema, {
      headRecordId: null,
      seq: -1,
      recordCount: -1,
    });
    expect(parsed).toBeNull();
  });
});

describe('logPageResponseSchema', () => {
  const envelope: SignedRecordEnvelope = {
    version: 2,
    type: 'identity',
    subject: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
    issuer: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
    record: { handle: '@nate' },
    issuedAt: 1750000000000,
    seq: 0,
    prev: null,
    collection: 'app.oxy.identity',
    rkey: 'self',
    publicKey: '02a1b2c3',
    alg: 'ES256K-DER-SHA256',
    signature: '3045...',
  };

  it('round-trips a page of full envelopes with its count', () => {
    const page: LogPageResponse = { records: [envelope], count: 1 };
    const parsed = safeParseContract(logPageResponseSchema, page);
    expect(parsed).not.toBeNull();
    expect(parsed?.count).toBe(1);
    expect(parsed?.records).toHaveLength(1);
  });

  it('round-trips an empty page', () => {
    const parsed = safeParseContract(logPageResponseSchema, { records: [], count: 0 });
    expect(parsed).toEqual({ records: [], count: 0 });
  });

  it('rejects a page carrying a malformed envelope', () => {
    const parsed = safeParseContract(logPageResponseSchema, {
      records: [{ ...envelope, alg: 'RS256' }],
      count: 1,
    });
    expect(parsed).toBeNull();
  });
});

describe('LexiconRecord<TPayload> (typed projection)', () => {
  it('types an app payload addressed by (collection, rkey)', () => {
    interface MentionPost {
      text: string;
      createdAt: number;
    }
    const projection: LexiconRecord<MentionPost> = {
      collection: 'app.mention.feed.post',
      rkey: 'post_1',
      record: { text: 'hello', createdAt: 1750000000000 },
    };
    expect(projection.collection).toBe('app.mention.feed.post');
    expect(projection.rkey).toBe('post_1');
    expect(projection.record.text).toBe('hello');
  });
});
