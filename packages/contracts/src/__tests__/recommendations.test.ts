import {
    recommendationRequestSchema,
    recommendationItemSchema,
    recommendationResponseSchema,
    recommendationBoostSchema,
    recommendationSignalWeightsSchema,
    appUserSignalIngestSchema,
    appAffinityEventSchema,
    appAffinityEventsIngestSchema,
    safeParseContract,
} from '../index';

/**
 * The recommendation contracts MUST accept exactly what the scored
 * `POST /profiles/recommendations` path emits and the `POST /app-signals/ingest`
 * path accepts, and reject malformed payloads at the contract boundary so the
 * producer (API) and the consumer SDKs cannot drift.
 */
describe('recommendationRequestSchema', () => {
    it('accepts an empty body (all fields optional)', () => {
        const parsed = safeParseContract(recommendationRequestSchema, {});
        expect(parsed).not.toBeNull();
    });

    it('accepts a fully-specified request', () => {
        const parsed = safeParseContract(recommendationRequestSchema, {
            clientId: '64f7c2a1b8e9d3f4a1c2b3d4',
            limit: 20,
            offset: 40,
            excludeTypes: ['federated', 'agent'],
            excludeIds: ['64f7c2a1b8e9d3f4a1c2b3d4'],
            boosts: [{ userIds: ['a', 'b'], weight: 2, reason: 'editorial' }],
            signalWeights: { graph: 3, repCandidate: 1.5 },
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.limit).toBe(20);
        expect(parsed?.boosts?.[0]?.weight).toBe(2);
    });

    it('rejects a limit above the cap', () => {
        const parsed = safeParseContract(recommendationRequestSchema, { limit: 101 });
        expect(parsed).toBeNull();
    });

    it('rejects a negative offset', () => {
        const parsed = safeParseContract(recommendationRequestSchema, { offset: -1 });
        expect(parsed).toBeNull();
    });

    it('rejects an unknown exclude type', () => {
        const parsed = safeParseContract(recommendationRequestSchema, {
            excludeTypes: ['banana'],
        });
        expect(parsed).toBeNull();
    });

    it('rejects more than 500 excludeIds', () => {
        const parsed = safeParseContract(recommendationRequestSchema, {
            excludeIds: Array.from({ length: 501 }, (_, i) => `id_${i}`),
        });
        expect(parsed).toBeNull();
    });

    it('rejects more than 50 boosts', () => {
        const parsed = safeParseContract(recommendationRequestSchema, {
            boosts: Array.from({ length: 51 }, () => ({ userIds: ['a'], weight: 1 })),
        });
        expect(parsed).toBeNull();
    });
});

describe('recommendationBoostSchema', () => {
    it('rejects a weight beyond the [-5, 5] range', () => {
        expect(safeParseContract(recommendationBoostSchema, { userIds: ['a'], weight: 6 })).toBeNull();
        expect(safeParseContract(recommendationBoostSchema, { userIds: ['a'], weight: -6 })).toBeNull();
    });

    it('rejects an empty userIds array', () => {
        expect(safeParseContract(recommendationBoostSchema, { userIds: [], weight: 1 })).toBeNull();
    });

    it('rejects more than 200 userIds', () => {
        const parsed = safeParseContract(recommendationBoostSchema, {
            userIds: Array.from({ length: 201 }, (_, i) => `id_${i}`),
            weight: 1,
        });
        expect(parsed).toBeNull();
    });

    it('rejects a reason longer than 120 chars', () => {
        const parsed = safeParseContract(recommendationBoostSchema, {
            userIds: ['a'],
            weight: 1,
            reason: 'x'.repeat(121),
        });
        expect(parsed).toBeNull();
    });
});

describe('recommendationSignalWeightsSchema', () => {
    it('accepts a partial set of weights', () => {
        const parsed = safeParseContract(recommendationSignalWeightsSchema, { graph: 1 });
        expect(parsed).not.toBeNull();
    });

    it('accepts an affinity weight (the phase-2 interaction-affinity signal)', () => {
        const parsed = safeParseContract(recommendationSignalWeightsSchema, { affinity: 2.5 });
        expect(parsed).not.toBeNull();
        expect(parsed?.affinity).toBe(2.5);
    });

    it('rejects a weight above 10', () => {
        const parsed = safeParseContract(recommendationSignalWeightsSchema, { graph: 11 });
        expect(parsed).toBeNull();
    });

    it('rejects an affinity weight above 10', () => {
        const parsed = safeParseContract(recommendationSignalWeightsSchema, { affinity: 11 });
        expect(parsed).toBeNull();
    });

    it('rejects a negative weight', () => {
        const parsed = safeParseContract(recommendationSignalWeightsSchema, { interest: -1 });
        expect(parsed).toBeNull();
    });
});

describe('appAffinityEventSchema', () => {
    it('accepts a minimal event (from, to, type)', () => {
        const parsed = safeParseContract(appAffinityEventSchema, {
            fromUserId: '64f7c2a1b8e9d3f4a1c2b3d4',
            toUserId: '64f7c2a1b8e9d3f4a1c2b3d5',
            type: 'like',
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.type).toBe('like');
    });

    it('accepts a fully-specified event (weight, occurredAt, eventId)', () => {
        const parsed = safeParseContract(appAffinityEventSchema, {
            fromUserId: 'a',
            toUserId: 'b',
            type: 'follow',
            weight: 7,
            occurredAt: '2026-07-03T12:00:00.000Z',
            eventId: 'evt_123',
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.weight).toBe(7);
        expect(parsed?.eventId).toBe('evt_123');
    });

    it('rejects an unknown event type', () => {
        const parsed = safeParseContract(appAffinityEventSchema, {
            fromUserId: 'a',
            toUserId: 'b',
            type: 'block',
        });
        expect(parsed).toBeNull();
    });

    it('rejects a negative weight', () => {
        const parsed = safeParseContract(appAffinityEventSchema, {
            fromUserId: 'a',
            toUserId: 'b',
            type: 'like',
            weight: -1,
        });
        expect(parsed).toBeNull();
    });

    it('rejects a non-ISO occurredAt', () => {
        const parsed = safeParseContract(appAffinityEventSchema, {
            fromUserId: 'a',
            toUserId: 'b',
            type: 'like',
            occurredAt: 'yesterday',
        });
        expect(parsed).toBeNull();
    });

    it('rejects an empty fromUserId', () => {
        const parsed = safeParseContract(appAffinityEventSchema, {
            fromUserId: '',
            toUserId: 'b',
            type: 'like',
        });
        expect(parsed).toBeNull();
    });
});

describe('appAffinityEventsIngestSchema', () => {
    it('accepts a non-empty batch of events', () => {
        const parsed = safeParseContract(appAffinityEventsIngestSchema, {
            events: [
                { fromUserId: 'a', toUserId: 'b', type: 'reply' },
                { fromUserId: 'a', toUserId: 'c', type: 'boost', weight: 3 },
            ],
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.events.length).toBe(2);
    });

    it('rejects an empty events array', () => {
        expect(safeParseContract(appAffinityEventsIngestSchema, { events: [] })).toBeNull();
    });

    it('rejects a missing events array', () => {
        expect(safeParseContract(appAffinityEventsIngestSchema, {})).toBeNull();
    });

    it('rejects more than 1000 events', () => {
        const parsed = safeParseContract(appAffinityEventsIngestSchema, {
            events: Array.from({ length: 1001 }, () => ({
                fromUserId: 'a',
                toUserId: 'b',
                type: 'like' as const,
            })),
        });
        expect(parsed).toBeNull();
    });
});

describe('recommendationItemSchema / recommendationResponseSchema', () => {
    it('accepts a scored item with the canonical name shape', () => {
        const parsed = safeParseContract(recommendationItemSchema, {
            id: '64f7c2a1b8e9d3f4a1c2b3d4',
            username: 'alice',
            name: { first: 'Alice', displayName: 'Alice Example' },
            avatar: 'file_1',
            color: 'teal',
            verified: true,
            trustTier: 'trusted',
            mutualCount: 3,
            score: 12.5,
            matchedSignals: ['graph', 'verified'],
            _count: { followers: 10, following: 4 },
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.name.displayName).toBe('Alice Example');
        expect(parsed?.score).toBe(12.5);
        expect(parsed?.color).toBe('teal');
    });

    it('accepts an unscored item (GET back-compat path: no score/matchedSignals)', () => {
        const parsed = safeParseContract(recommendationItemSchema, {
            id: 'x',
            name: { displayName: 'Bob' },
            mutualCount: 0,
            _count: { followers: 0, following: 0 },
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.score).toBeUndefined();
    });

    it('accepts an item missing name.displayName (displayName is now optional)', () => {
        const parsed = safeParseContract(recommendationItemSchema, {
            id: 'x',
            name: { first: 'Bob' },
            mutualCount: 0,
            _count: { followers: 0, following: 0 },
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.name.displayName).toBeUndefined();
    });

    it('parses an array response', () => {
        const parsed = safeParseContract(recommendationResponseSchema, [
            { id: 'x', name: { displayName: 'A' }, mutualCount: 0, _count: { followers: 0, following: 0 } },
        ]);
        expect(parsed).not.toBeNull();
        expect(parsed?.length).toBe(1);
    });
});

describe('appUserSignalIngestSchema', () => {
    it('accepts endorsements with a defaulted op', () => {
        const parsed = safeParseContract(appUserSignalIngestSchema, {
            endorsements: [{ ownerId: 'o1', memberId: 'm1', sourceId: 's1' }],
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.endorsements?.[0]?.op).toBe('add');
    });

    it('accepts interests only', () => {
        const parsed = safeParseContract(appUserSignalIngestSchema, {
            interests: [{ userId: 'u1', interestScore: 0.5 }],
        });
        expect(parsed).not.toBeNull();
    });

    it('rejects a payload with neither endorsements nor interests', () => {
        expect(safeParseContract(appUserSignalIngestSchema, {})).toBeNull();
        expect(
            safeParseContract(appUserSignalIngestSchema, { endorsements: [], interests: [] }),
        ).toBeNull();
    });

    it('rejects an interestScore outside [0, 1]', () => {
        const parsed = safeParseContract(appUserSignalIngestSchema, {
            interests: [{ userId: 'u1', interestScore: 1.5 }],
        });
        expect(parsed).toBeNull();
    });

    it('rejects more than 500 endorsements', () => {
        const parsed = safeParseContract(appUserSignalIngestSchema, {
            endorsements: Array.from({ length: 501 }, (_, i) => ({
                ownerId: `o${i}`,
                memberId: `m${i}`,
            })),
        });
        expect(parsed).toBeNull();
    });
});
