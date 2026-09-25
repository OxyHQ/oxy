import {
  describeReputationAction,
  formatPointsDelta,
} from '@/lib/civic/reputation-activity';

describe('describeReputationAction', () => {
  it('maps a known civic action to its icon, label, and signed provenance', () => {
    expect(
      describeReputationAction({ actionType: 'peer_validated', category: 'trust', points: 8 }),
    ).toEqual({
      icon: 'community',
      labelKey: 'peerValidated',
      signed: true,
      positive: true,
    });
  });

  it('flags a real-life attestation as signed and positive', () => {
    expect(
      describeReputationAction({ actionType: 'real_life_attested', category: 'physical', points: 25 }),
    ).toMatchObject({ labelKey: 'realLife', signed: true, positive: true });
  });

  it('flags a penalising civic action as not positive but still signed', () => {
    expect(
      describeReputationAction({ actionType: 'validation_incorrect', category: 'moderation', points: -10 }),
    ).toMatchObject({ labelKey: 'validationIncorrect', signed: true, positive: false });
  });

  it('falls back to the category bucket for an unknown action type', () => {
    expect(
      describeReputationAction({ actionType: 'mystery_award', category: 'penalty', points: -3 }),
    ).toEqual({
      icon: 'alertStrong',
      labelKey: 'penalty',
      signed: false,
      positive: false,
    });
  });

  it('treats content/social app activity as an unsigned category fallback', () => {
    expect(
      describeReputationAction({ actionType: 'post_created', category: 'content', points: 2 }),
    ).toMatchObject({ labelKey: 'content', signed: false, positive: true });
  });
});

describe('formatPointsDelta', () => {
  it('prefixes awards with "+" and preserves the minus on penalties', () => {
    expect(formatPointsDelta(8)).toBe('+8');
    expect(formatPointsDelta(-10)).toBe('-10');
    expect(formatPointsDelta(0)).toBe('+0');
  });
});
