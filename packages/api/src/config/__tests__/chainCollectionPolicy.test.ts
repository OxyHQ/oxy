/**
 * The chain-collection policy — the one place that knows which collections on a
 * person's chain may be served to anyone else.
 *
 * The cases that matter are the ones a careless change would break silently: an
 * undeclared collection must NOT become readable, the derived public list must
 * stay derived rather than repeated, and the node-bootstrap allowlist must stay
 * inside what the policy permits. Every one of these is a privacy boundary, so
 * each is written to fail loudly rather than to describe the current array.
 */

import {
  CHAIN_COLLECTION_POLICY,
  PUBLIC_CHAIN_COLLECTIONS,
  isPublicChainCollection,
  publicCollectionsAmong,
} from '../chainCollectionPolicy';
import { PUBLIC_LOG_COLLECTIONS } from '../../services/repoLog.service';

describe('chainCollectionPolicy', () => {
  it('treats an UNDECLARED collection as private', () => {
    // The default is the whole point: an app that ships a collection and forgets
    // this file must get silence on a public read, not disclosure.
    expect(isPublicChainCollection('app.syra.listen')).toBe(false);
    expect(isPublicChainCollection('app.mention.feed.somethingNew')).toBe(false);
    expect(isPublicChainCollection('')).toBe(false);
  });

  it('keeps a saved post private', () => {
    // Named rather than derived from the array: this is the case the policy
    // exists for, and a test that read the array would agree with any mistake.
    expect(isPublicChainCollection('app.mention.feed.bookmark')).toBe(false);
    expect(PUBLIC_CHAIN_COLLECTIONS).not.toContain('app.mention.feed.bookmark');
  });

  it('publishes the collections a reader legitimately needs', () => {
    for (const nsid of [
      'app.oxy.identity',
      'app.oxy.profile',
      'app.oxy.node',
      'app.mention.feed.post',
      'app.mention.feed.repost',
      'app.mention.feed.like',
      'app.mention.feed.tombstone',
    ]) {
      expect(isPublicChainCollection(nsid)).toBe(true);
    }
  });

  it('derives the public list from the policy instead of repeating it', () => {
    const declaredPublic = CHAIN_COLLECTION_POLICY.filter((e) => e.visibility === 'public').map((e) => e.nsid);
    expect([...PUBLIC_CHAIN_COLLECTIONS].sort()).toEqual([...declaredPublic].sort());
    // Vacuity floor: an empty or truncated policy would satisfy the equality above.
    expect(PUBLIC_CHAIN_COLLECTIONS.length).toBeGreaterThanOrEqual(7);
  });

  it('states a reason for every entry, because the next person has to judge by it', () => {
    for (const entry of CHAIN_COLLECTION_POLICY) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('declares each collection exactly once', () => {
    const nsids = CHAIN_COLLECTION_POLICY.map((e) => e.nsid);
    // A duplicate with a DIFFERENT visibility would resolve by map insertion
    // order — silently, and differently depending on which entry came last.
    expect(new Set(nsids).size).toBe(nsids.length);
  });

  it('keeps the node-bootstrap allowlist inside what the policy permits', () => {
    // The two lists answer different questions and are deliberately separate
    // (see `repoLog.service`), but the bootstrap one may never name a collection
    // this policy calls private.
    for (const nsid of PUBLIC_LOG_COLLECTIONS) {
      expect(isPublicChainCollection(nsid)).toBe(true);
    }
  });

  describe('publicCollectionsAmong', () => {
    it('drops the private ones from a caller-supplied filter', () => {
      expect(
        publicCollectionsAmong(['app.mention.feed.post', 'app.mention.feed.bookmark']),
      ).toEqual(['app.mention.feed.post']);
    });

    it('answers an all-private request with nothing, not with everything', () => {
      // The failure mode worth pinning: a narrowing that returns the full public
      // set when the intersection is empty would hand a caller more than it asked
      // for, which is how "filter" implementations usually break.
      expect(publicCollectionsAmong(['app.mention.feed.bookmark'])).toEqual([]);
      expect(publicCollectionsAmong([])).toEqual([]);
    });

    it('preserves the caller order and does not invent entries', () => {
      const requested = ['app.mention.feed.like', 'app.syra.listen', 'app.oxy.profile'];
      expect(publicCollectionsAmong(requested)).toEqual(['app.mention.feed.like', 'app.oxy.profile']);
    });
  });
});
