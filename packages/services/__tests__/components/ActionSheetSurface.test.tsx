/**
 * `ActionSheetSurface` (P3) — the shared multi-choice surface that backs the
 * download-format and file-visibility choosers (the many-option counterpart to
 * Bloom's two-way `surfaces.confirm`). Each option button resolves the surface
 * with that option's `value`; cancel resolves `undefined`.
 */

import { render, screen } from '@testing-library/react';
import { ActionSheetSurface } from '../../src/ui/components/surfaces/ActionSheetSurface';
import type { SurfaceControls } from '@oxy.so/bloom/surfaces';

const makeSurface = (): SurfaceControls => ({
  dismiss: jest.fn(),
  present: jest.fn(),
});

describe('ActionSheetSurface', () => {
  it('dismisses with the pressed option value', () => {
    const surface = makeSurface();
    render(
      <ActionSheetSurface
        surface={surface}
        title="Change Visibility"
        message="Pick one"
        options={[
          { label: 'Private', value: 'private' },
          { label: 'Public', value: 'public' },
          { label: 'Unlisted', value: 'unlisted' },
        ]}
        cancelLabel="Cancel"
      />,
    );

    screen.getByText('Public').click();
    expect(surface.dismiss).toHaveBeenCalledWith('public');
  });

  it('dismisses with undefined on cancel', () => {
    const surface = makeSurface();
    render(
      <ActionSheetSurface
        surface={surface}
        title="Download account data"
        options={[
          { label: 'JSON', value: 'json' },
          { label: 'CSV', value: 'csv' },
        ]}
        cancelLabel="Cancel"
      />,
    );

    screen.getByText('Cancel').click();
    expect(surface.dismiss).toHaveBeenCalledWith(undefined);
  });
});
