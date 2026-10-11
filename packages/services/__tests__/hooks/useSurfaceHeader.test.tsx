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
