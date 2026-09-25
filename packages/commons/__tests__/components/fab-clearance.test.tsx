/**
 * The ID screen's QR FAB floated over "You hold the private key. No one can
 * lock you out." with no way to scroll the text out from under it
 * (OxyHQ/oxy#1375 item 19). The content's bottom inset now clears the FAB.
 */
import React from 'react';
import { render } from '@testing-library/react';

let mockBottomEdgeInset = 0;
const TAB_BAR_FOOTPRINT = 82;

jest.mock('@oxy.so/bloom/layout', () => ({ useBottomEdgeInset: () => mockBottomEdgeInset }));
jest.mock('@oxy.so/bloom/tab-bar', () => ({ useTabBarFootprint: () => TAB_BAR_FOOTPRINT }));
jest.mock('@/hooks/useColors', () => ({ useColors: () => ({ background: '#fff' }) }));
jest.mock('@/components/screen-content-wrapper', () => ({
  ScreenContentWrapper: ({ children }: { children?: React.ReactNode }) => children,
}));

import { FAB_MD_DIAMETER, useFabClearance, useScreenBottomPad } from '@/components/ui/screen';

function measure(fabOffset: number) {
  const out: { clearance?: number; screenPad?: number } = {};
  function Probe() {
    out.clearance = useFabClearance(fabOffset);
    out.screenPad = useScreenBottomPad();
    return null;
  }
  render(<Probe />);
  return out as { clearance: number; screenPad: number };
}

describe('useFabClearance', () => {
  it.each([0, TAB_BAR_FOOTPRINT])(
    'clears the whole FAB (bottom-edge inset %i) with air to spare',
    (inset) => {
      mockBottomEdgeInset = inset;
      // Where Bloom's Fab puts its top edge: offset + claimed inset + diameter.
      const fabTop = TAB_BAR_FOOTPRINT + inset + FAB_MD_DIAMETER;
      const { clearance } = measure(TAB_BAR_FOOTPRINT);
      expect(clearance).toBeGreaterThan(fabTop);
    },
  );

  it('never pads less than an ordinary screen', () => {
    mockBottomEdgeInset = 0;
    const { clearance, screenPad } = measure(0);
    expect(clearance).toBeGreaterThanOrEqual(screenPad);
  });
});
