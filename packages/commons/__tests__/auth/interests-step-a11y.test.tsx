/**
 * "Build around what you love" is a Skia physics canvas: pixels and gestures,
 * with no accessibility tree, so a TalkBack user could not pick a single
 * interest (OxyHQ/oxy#1375 item 17). With a screen reader on, the same tags are
 * Bloom chips — one toggle each, with its label and selected state.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AccessibilityInfo } from 'react-native';
import { INTEREST_TAGS } from '@/constants/interestTags';

jest.mock('@oxy.so/bloom/chip', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    Chip: ({
      children,
      selected,
      onPress,
    }: {
      children?: React.ReactNode;
      selected?: boolean;
      onPress?: () => void;
    }) =>
      R.createElement(
        'button',
        { type: 'button', onClick: onPress, 'aria-pressed': selected ? 'true' : 'false' },
        children,
      ),
  };
});
jest.mock('@/components/ui', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    Button: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
      R.createElement('button', { type: 'button', onClick: onPress }, children),
  };
});
jest.mock('@/hooks/useColors', () => ({ useColors: () => ({ background: '#fff', text: '#000' }) }));
jest.mock('@/components/auth/InterestTagsCanvas', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return { InterestTagsCanvas: () => R.createElement('div', { 'data-testid': 'interest-canvas' }) };
});

import { InterestsStep } from '@/components/auth/InterestsStep';

type A11yMock = typeof AccessibilityInfo & { screenReaderEnabled: boolean };

async function renderStep(screenReaderEnabled: boolean, onContinue = jest.fn()) {
  (AccessibilityInfo as A11yMock).screenReaderEnabled = screenReaderEnabled;
  const utils = render(<InterestsStep onContinue={onContinue} />);
  // Let the screen-reader probe resolve.
  await act(async () => undefined);
  return utils;
}

describe('InterestsStep with a screen reader', () => {
  it('offers every tag as a toggle with its label', async () => {
    await renderStep(true);
    for (const tag of INTEREST_TAGS) {
      const chip = screen.getByRole('button', { name: tag.label });
      expect(chip.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('toggles a tag, reports its state, and continues with the selection', async () => {
    const onContinue = jest.fn();
    await renderStep(true, onContinue);

    fireEvent.click(screen.getByRole('button', { name: 'Music' }));
    expect(screen.getByRole('button', { name: 'Music' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('1 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledWith(['music']);
  });
});

describe('InterestsStep without a screen reader', () => {
  it('keeps the physics canvas and hides it from assistive technology', async () => {
    const { container } = await renderStep(false);
    expect(screen.queryByRole('button', { name: 'Music' })).toBeNull();
    // The canvas mounts once the footer is measured; its layer is hidden either way.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
