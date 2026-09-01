import { act, render } from '@testing-library/react';
import { createElement, useMemo, useState, type ReactNode } from 'react';
import {
  SurfaceHeaderContext,
  useSurfaceHeader,
  type SurfaceHeaderContent,
} from '../../src/ui/hooks/useSurfaceHeader';

/**
 * The bridge's ONLY real failure mode is a feedback loop, so it can only be
 * caught by a host that actually closes the loop: the sibling `useSurfaceHeader`
 * tests pass a `jest.fn()` as `setContent`, which never re-renders the screen and
 * therefore cannot fail no matter how broken the comparator is.
 *
 * This host is `SurfaceScreen`'s bridge in miniature — `useState` + a stable
 * context value — so a push re-renders the screen exactly as it does in the app.
 * If the comparator lets reference churn through, React tears the tree down with
 * "Maximum update depth exceeded" (the minified error #185 seen in production).
 */
function renderWithLoopingHost(Screen: () => null): {
  pushes: Array<SurfaceHeaderContent | null>;
  screenRenders: () => number;
} {
  const pushes: Array<SurfaceHeaderContent | null> = [];
  let renders = 0;

  const CountingScreen = (): null => {
    renders += 1;
    return Screen();
  };

  const Host = (): ReactNode => {
    const [, setContent] = useState<SurfaceHeaderContent | null>(null);
    const value = useMemo(
      () => ({
        setContent: (next: SurfaceHeaderContent | null) => {
          pushes.push(next);
          setContent(next);
        },
      }),
      [],
    );
    return createElement(
      SurfaceHeaderContext.Provider,
      { value },
      createElement(CountingScreen),
    );
  };

  render(createElement(Host));
  return { pushes, screenRenders: () => renders };
}

describe('useSurfaceHeader — update-loop containment', () => {
  it('settles when a screen rebuilds its primaryAction object every render', () => {
    // Verbatim shape of the profile-banner picker: FileManagementScreen's
    // `pickerPrimaryAction` is a `useMemo` keyed on `handleFileUpload`, which
    // `useFileUploadState` re-created on every render — so the memo yielded a
    // FRESH `primaryAction` object with identical contents every render.
    const Screen = (): null => {
      const onPress = () => undefined;
      useSurfaceHeader({
        title: 'Choose Photo',
        largeTitle: false,
        primaryAction: { label: 'Upload', onPress, loading: false },
        tone: 'onImage',
      });
      return null;
    };

    const { pushes, screenRenders } = renderWithLoopingHost(Screen);

    // Exactly one push (the initial contribution) and one re-render to consume it.
    expect(pushes).toHaveLength(1);
    expect(screenRenders()).toBe(2);
  });

  it('settles when a screen rebuilds actions / search / segments / progress every render', () => {
    const icon = createElement('span');
    const Screen = (): null => {
      useSurfaceHeader({
        title: 'Files',
        actions: [{ icon, accessibilityLabel: 'Sort', onPress: () => undefined }],
        search: { value: '', onChangeText: () => undefined, placeholder: 'Search' },
        segments: {
          items: [{ key: 'all', label: 'All' }],
          value: 'all',
          onChange: () => undefined,
        },
        progress: { step: 1, total: 3 },
      });
      return null;
    };

    const { pushes, screenRenders } = renderWithLoopingHost(Screen);

    expect(pushes).toHaveLength(1);
    expect(screenRenders()).toBe(2);
  });

  it('stays settled when an unrelated external re-render sweeps the surface', () => {
    // A mounted surface is re-rendered by things that have nothing to do with the
    // header — a realtime socket teardown, a query settling, a theme change. Such
    // a sweep must not push anything, let alone re-enter the loop: the screen
    // rebuilds its `primaryAction` object on that render like any other.
    const pushes: Array<SurfaceHeaderContent | null> = [];

    const Screen = (): null => {
      useSurfaceHeader({
        title: 'Choose Photo',
        primaryAction: { label: 'Upload', onPress: () => undefined, loading: false },
      });
      return null;
    };

    let sweep: (() => void) | undefined;

    const Host = (): ReactNode => {
      const [, setContent] = useState<SurfaceHeaderContent | null>(null);
      // Stands in for any external subscription the surface sits under.
      const [, setExternalTick] = useState(0);
      sweep = () => setExternalTick((n) => n + 1);
      const value = useMemo(
        () => ({
          setContent: (next: SurfaceHeaderContent | null) => {
            pushes.push(next);
            setContent(next);
          },
        }),
        [],
      );
      return createElement(SurfaceHeaderContext.Provider, { value }, createElement(Screen));
    };

    render(createElement(Host));
    expect(pushes).toHaveLength(1);

    act(() => sweep?.());
    act(() => sweep?.());

    expect(pushes).toHaveLength(1);
  });

  it('still pushes when a primaryAction scalar actually changes', () => {
    // The containment must not go so far that a real change is swallowed: the
    // Upload CTA's spinner has to reach the header.
    const pushes: Array<SurfaceHeaderContent | null> = [];

    const Screen = ({ loading }: { loading: boolean }): null => {
      useSurfaceHeader({
        title: 'Choose Photo',
        primaryAction: { label: 'Upload', onPress: () => undefined, loading },
      });
      return null;
    };

    const Host = ({ loading }: { loading: boolean }): ReactNode => {
      const [, setContent] = useState<SurfaceHeaderContent | null>(null);
      const value = useMemo(
        () => ({
          setContent: (next: SurfaceHeaderContent | null) => {
            pushes.push(next);
            setContent(next);
          },
        }),
        [],
      );
      return createElement(
        SurfaceHeaderContext.Provider,
        { value },
        createElement(Screen, { loading }),
      );
    };

    const { rerender } = render(createElement(Host, { loading: false }));
    expect(pushes).toHaveLength(1);

    rerender(createElement(Host, { loading: true }));
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.primaryAction?.loading).toBe(true);
  });
});
