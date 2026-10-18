import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import {
  SurfaceHeaderContext,
  useSurfaceHeader,
  type SurfaceHeaderContent,
} from '../../src/ui/hooks/useSurfaceHeader';

const makeWrapper = (setContent = jest.fn()) => {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SurfaceHeaderContext.Provider, { value: { setContent } }, children);
  return { Wrapper, setContent };
};

describe('useSurfaceHeader', () => {
  it('pushes content once when inline object values are stable across renders', () => {
    const { Wrapper, setContent } = makeWrapper();

    const { rerender } = renderHook(
      () => useSurfaceHeader({ title: 'Files', subtitle: 'Manage uploads' }),
      { wrapper: Wrapper },
    );

    expect(setContent).toHaveBeenCalledTimes(1);
    expect(setContent).toHaveBeenLastCalledWith({ title: 'Files', subtitle: 'Manage uploads' });

    rerender();
    rerender();

    expect(setContent).toHaveBeenCalledTimes(1);
  });

  it('pushes again only when a scalar header field changes', () => {
    const { Wrapper, setContent } = makeWrapper();

    const { rerender } = renderHook(({ title }: { title: string }) => useSurfaceHeader({ title }), {
      wrapper: Wrapper,
      initialProps: { title: 'First' },
    });

    expect(setContent).toHaveBeenCalledTimes(1);

    rerender({ title: 'Second' });
    expect(setContent).toHaveBeenCalledTimes(2);
    expect(setContent).toHaveBeenLastCalledWith({ title: 'Second' });
  });

  it('treats onBack presence as stable even when the callback identity changes', () => {
    const { Wrapper, setContent } = makeWrapper();

    const { rerender } = renderHook(
      ({ onBack }: { onBack: () => void }) => useSurfaceHeader({ title: 'Edit', onBack }),
      {
        wrapper: Wrapper,
        initialProps: { onBack: () => undefined },
      },
    );

    expect(setContent).toHaveBeenCalledTimes(1);

    rerender({ onBack: () => undefined });
    expect(setContent).toHaveBeenCalledTimes(1);
  });

  it('keeps a stable back affordance while invoking the latest committed callback', () => {
    const { Wrapper, setContent } = makeWrapper();
    const first = jest.fn();
    const latest = jest.fn();
    const { rerender } = renderHook(
      ({ onBack }: { onBack?: () => void }) => useSurfaceHeader({ title: 'Account', onBack }),
      { wrapper: Wrapper, initialProps: { onBack: first } },
    );
    const published = setContent.mock.calls[0][0].onBack;
    rerender({ onBack: latest });
    expect(setContent).toHaveBeenCalledTimes(1);
    published();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    rerender({ onBack: undefined });
    expect(setContent.mock.lastCall?.[0].onBack).toBeUndefined();
    published();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('clears the host contribution on unmount', () => {
    const { Wrapper, setContent } = makeWrapper();

    const { unmount } = renderHook(
      () => useSurfaceHeader({ title: 'Done' } satisfies SurfaceHeaderContent),
      { wrapper: Wrapper },
    );

    setContent.mockClear();
    act(() => {
      unmount();
    });

    expect(setContent).toHaveBeenCalledWith(null);
  });
});

test('stable header controls dispatch to the latest form, selection and search callbacks', () => {
  const { Wrapper, setContent } = makeWrapper();
  const first = jest.fn();
  const latest = jest.fn();
  const icon = () => null;
  const { rerender, unmount } = renderHook(
    ({ callback }) =>
      useSurfaceHeader({
        title: 'Edit',
        primaryAction: { label: 'Save', onPress: callback },
        actions: [{ icon, accessibilityLabel: 'Delete', onPress: callback }],
        search: { value: '', onValueChange: callback, onSubmit: callback },
        segments: { items: [{ key: 'all', label: 'All' }], value: 'all', onChange: callback },
      }),
    { wrapper: Wrapper, initialProps: { callback: first } },
  );
  const header = setContent.mock.calls[0][0] as SurfaceHeaderContent;
  rerender({ callback: latest });
  expect(setContent).toHaveBeenCalledTimes(1);
  header.primaryAction?.onPress();
  header.actions?.[0].onPress();
  header.search?.onValueChange('query');
  header.search?.onSubmit?.();
  header.segments?.onChange('all');
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(5);
  expect(latest).toHaveBeenCalledWith('query');
  expect(latest).toHaveBeenCalledWith('all');
  unmount();
  header.primaryAction?.onPress();
  expect(latest).toHaveBeenCalledTimes(5);
});
