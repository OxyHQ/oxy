import React from 'react';
import { render } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxyhq-services';
import { __resetAsyncStorage } from '@/__mocks__/async-storage';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import { StandingSection } from '@/components/reputation/StandingSection';
import { deriveReputationSources } from '@/lib/civic/reputation-sources';
import type { ReputationBalance } from '@oxyhq/contracts';

const BALANCE: ReputationBalance = {
  userId: 'me',
  total: 47,
  positive: 57,
  negative: -10,
  breakdown: { content: 5, social: 3, trust: 8, moderation: 0, physical: 25, penalties: 10 },
  trustTier: 'new',
  influence: { defaultWeight: 1.4, reportWeight: 1.4, moderationWeight: 0.7, rankingFeedbackWeight: 1.1 },
  reliability: { accurateReports: 9, rejectedReports: 1, reportAccuracyScore: 0.9, abuseScore: 0.05 },
  recalculatedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderStanding(
  balance: ReputationBalance,
  isOffline = false,
) {
  const sources = deriveReputationSources(balance.breakdown);
  return render(
    <LocaleProvider>
      <StandingSection balance={balance} sources={sources} isOffline={isOffline} />
    </LocaleProvider>,
  );
}

describe('StandingSection', () => {
  beforeEach(() => {
    __resetAsyncStorage();
    __resetOxyState();
    __setOxyState({ user: { id: 'me', language: 'en-US' } });
  });

  it('renders the standing headline, total, tier chip, and progress toward the next tier', () => {
    const { container } = renderStanding(BALANCE);
    expect(container.textContent).toContain('Standing');
    expect(container.textContent).toContain('47');
    expect(container.textContent).toContain('New');
    expect(container.textContent).toContain('47 → 100');
    expect(container.textContent).toContain('53 to Trusted');
  });

  it('renders positive reputation sources with labels and point values', () => {
    const { container } = renderStanding(BALANCE);
    expect(container.textContent).toContain('Real life');
    expect(container.textContent).toContain('Peer & civic');
    expect(container.textContent).toContain('Apps');
    expect(container.textContent).toContain('25');
    expect(container.textContent).toContain('8');
  });

  it('breaks penalties out separately as a subtracted value', () => {
    const { container } = renderStanding(BALANCE);
    expect(container.textContent).toContain('Penalties');
    expect(container.textContent).toContain('-10');
  });

  it('renders the influence and reliability stat chips', () => {
    const { container } = renderStanding(BALANCE);
    expect(container.textContent).toContain('×1.4');
    expect(container.textContent).toContain('90%');
    expect(container.textContent).toContain('Influence');
    expect(container.textContent).toContain('Reliability');
  });

  it('renders the verified max state with no points progress', () => {
    const { container } = renderStanding({ ...BALANCE, trustTier: 'verified', total: 1200 });
    expect(container.textContent).toContain('highest standing');
    expect(container.textContent).not.toContain('to Trusted');
  });

  it('shows the empty composition state when nothing has been earned or penalised', () => {
    const emptyBalance: ReputationBalance = {
      ...BALANCE,
      total: 0,
      positive: 0,
      negative: 0,
      breakdown: { content: 0, social: 0, trust: 0, moderation: 0, physical: 0, penalties: 0 },
    };
    const { container } = renderStanding(emptyBalance);
    expect(container.textContent).toContain('No reputation earned yet');
  });

  it('surfaces the offline chip when rendering cached data offline', () => {
    const { container } = renderStanding(BALANCE, true);
    expect(container.textContent).toContain('Offline');
  });
});
