import {
    isFullReputationBalance,
    REPUTATION_CATEGORIES,
    REPUTATION_DISPUTE_STATUSES,
    REPUTATION_TARGET_ENTITY_TYPES,
    REPUTATION_TRANSACTION_STATUSES,
    reputationBalanceSchema,
    reputationBalanceSummarySchema,
    reputationLeaderboardEntrySchema,
    reputationTransactionSchema,
    TRUST_TIERS,
    upsertReputationRuleSchema,
} from '../index';
import type {
    ReputationBalance,
    ReputationBalanceSummary,
    ReputationBalanceView,
    ReputationLeaderboardEntry,
    ReputationTransaction,
} from '../index';

/**
 * `GET /reputation/:userId/balance` is served in TWO views — the subject (and
 * platform staff) get the whole snapshot, everyone else gets the public trust
 * signal only. That split shipped server-side while the SDK still declared one
 * shape, so a read of `balance.reliability.reportAccuracyScore` type-checked
 * against a response that no longer carried `reliability` and threw at runtime.
 *
 * These tests lock the wire contract both views are now validated against on
 * the way out of the API: which fields belong to which view, that timestamps
 * are ISO strings rather than `Date`s, and that the runtime narrowing guard
 * demands the WHOLE private block rather than one representative field.
 */

const BALANCE: ReputationBalance = {
    userId: 'u1',
    total: 120,
    positive: 150,
    negative: -30,
    breakdown: {
        content: 80,
        social: 40,
        trust: 0,
        moderation: 0,
        physical: 0,
        penalties: 30,
    },
    trustTier: 'trusted',
    influence: {
        defaultWeight: 1,
        reportWeight: 1,
        moderationWeight: 1,
        rankingFeedbackWeight: 0.8,
    },
    reliability: {
        accurateReports: 2,
        rejectedReports: 0,
        reportAccuracyScore: 1,
        abuseScore: 0,
    },
    recalculatedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
};

const SUMMARY: ReputationBalanceSummary = {
    userId: 'u1',
    total: 120,
    trustTier: 'trusted',
};

const TRANSACTION: ReputationTransaction = {
    id: 't1',
    userId: 'u1',
    points: 25,
    actionType: 'real_life_attested',
    category: 'physical',
    status: 'active',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
};

const LEADERBOARD_ENTRY: ReputationLeaderboardEntry = {
    user: { id: 'u1', username: 'nate', name: { displayName: 'Nate' } },
    total: 120,
    trustTier: 'trusted',
    rank: 1,
};

describe('closed value sets', () => {
    it('carries every category, status, tier and target kind the ledger uses', () => {
        expect([...REPUTATION_CATEGORIES]).toEqual([
            'content',
            'social',
            'trust',
            'moderation',
            'physical',
            'penalty',
            'other',
        ]);
        expect([...REPUTATION_TRANSACTION_STATUSES]).toEqual([
            'active',
            'disputed',
            'reversed',
            'voided',
        ]);
        expect([...TRUST_TIERS]).toEqual([
            'restricted',
            'new',
            'trusted',
            'high_trust',
            'verified',
        ]);
        expect(REPUTATION_TARGET_ENTITY_TYPES).toHaveLength(9);
        expect([...REPUTATION_DISPUTE_STATUSES]).toEqual([
            'open',
            'accepted',
            'rejected',
            'needs_review',
        ]);
    });
});

describe('reputationBalanceSchema', () => {
    it('accepts the subject view', () => {
        expect(reputationBalanceSchema.safeParse(BALANCE).success).toBe(true);
    });

    it('rejects a Date where the wire promises an ISO string', () => {
        const withDate = { ...BALANCE, recalculatedAt: new Date() };
        expect(reputationBalanceSchema.safeParse(withDate).success).toBe(false);
    });

    it.each(['positive', 'negative', 'breakdown', 'influence', 'reliability', 'recalculatedAt', 'updatedAt'])(
        'rejects a subject view missing %s',
        (field) => {
            const partial: Record<string, unknown> = { ...BALANCE };
            delete partial[field];
            const result = reputationBalanceSchema.safeParse(partial);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
            }
        },
    );

    it('rejects a breakdown missing a category bucket', () => {
        const { social: _social, ...rest } = BALANCE.breakdown;
        expect(
            reputationBalanceSchema.safeParse({ ...BALANCE, breakdown: rest }).success,
        ).toBe(false);
    });
});

describe('reputationBalanceSummarySchema', () => {
    it('accepts the public view', () => {
        expect(reputationBalanceSummarySchema.safeParse(SUMMARY).success).toBe(true);
    });

    /*
     * The public view is what an ANONYMOUS caller gets. Parsing strips anything
     * outside the shape, so a private field cannot ride along even if a future
     * serializer hands one in — the compile-time annotation on the serializer is
     * the first line of defence, this is the second.
     */
    it('strips the private blocks rather than passing them through', () => {
        const parsed = reputationBalanceSummarySchema.parse(BALANCE);
        expect(parsed).toEqual(SUMMARY);
        expect(parsed).not.toHaveProperty('reliability');
        expect(parsed).not.toHaveProperty('influence');
        expect(parsed).not.toHaveProperty('breakdown');
    });
});

describe('isFullReputationBalance', () => {
    it('narrows the subject view', () => {
        const view: ReputationBalanceView = BALANCE;
        expect(isFullReputationBalance(view)).toBe(true);
        if (isFullReputationBalance(view)) {
            expect(view.reliability.abuseScore).toBe(0);
        }
    });

    it('refuses the public view', () => {
        expect(isFullReputationBalance(SUMMARY)).toBe(false);
    });

    it('refuses a payload carrying only SOME of the private fields', () => {
        for (const field of ['positive', 'breakdown', 'influence', 'reliability', 'updatedAt']) {
            const partial: Record<string, unknown> = { ...BALANCE };
            delete partial[field];
            expect(isFullReputationBalance(partial as ReputationBalanceView)).toBe(false);
        }
    });
});

describe('reputationTransactionSchema', () => {
    it('accepts a minimal active transaction', () => {
        expect(reputationTransactionSchema.safeParse(TRANSACTION).success).toBe(true);
    });

    it('rejects a category outside the closed set', () => {
        expect(
            reputationTransactionSchema.safeParse({ ...TRANSACTION, category: 'karma' }).success,
        ).toBe(false);
    });
});

describe('reputationLeaderboardEntrySchema', () => {
    /*
     * The leaderboard is public and its user projection is deliberately narrow.
     * `id` (not `_id`) is the field consumers key rows and route profiles on.
     */
    it('accepts an entry and requires the user id', () => {
        expect(reputationLeaderboardEntrySchema.safeParse(LEADERBOARD_ENTRY).success).toBe(true);
        const { id: _id, ...userWithoutId } = LEADERBOARD_ENTRY.user;
        expect(
            reputationLeaderboardEntrySchema.safeParse({
                ...LEADERBOARD_ENTRY,
                user: userWithoutId,
            }).success,
        ).toBe(false);
    });

    it('accepts a user with no resolved display name', () => {
        expect(
            reputationLeaderboardEntrySchema.safeParse({
                ...LEADERBOARD_ENTRY,
                user: { id: 'u2', username: 'anon', name: {} },
            }).success,
        ).toBe(true);
    });
});

describe('upsertReputationRuleSchema', () => {
    it('fills in the omitted cooldown and enabled flag', () => {
        const parsed = upsertReputationRuleSchema.parse({
            actionType: 'post_created',
            points: 2,
            category: 'content',
            description: 'Authored a post',
        });
        expect(parsed.cooldownInMinutes).toBe(0);
        expect(parsed.isEnabled).toBe(true);
    });

    it('rejects a category outside the closed set', () => {
        expect(
            upsertReputationRuleSchema.safeParse({
                actionType: 'post_created',
                points: 2,
                category: 'karma',
                description: 'Authored a post',
            }).success,
        ).toBe(false);
    });
});
