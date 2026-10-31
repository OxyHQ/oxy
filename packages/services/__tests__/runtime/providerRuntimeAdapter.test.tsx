/**
 * React as an adapter over the runtime (ADR 0004).
 *
 * The wide `useOxy()` value is rebuilt whenever any of its fifty-odd members
 * moves, so a locale change re-renders every auth consumer reading it. The
 * point of the runtime is that a hook selecting one fact off it does not. Both
 * halves are asserted here, because only the pair says anything: without the
 * positive control ("`useOxy()` DID re-render") a broken locale change would
 * look exactly like the isolation working.
 */

import type React from 'react';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => false,
}));

import { OxyRuntimeProvider, useOxy } from '../../src/ui/context/OxyContext';
import { OxyRuntimeMissingError, useOxyRuntime } from '../../src/runtime';
import type { OxyRuntime } from '../../src/runtime';
import { useActiveAccount } from '../../src/ui/runtime';

interface Counters {
  wide: number;
  selected: number;
}

const WideConsumer: React.FC<{ counters: Counters }> = ({ counters }) => {
  useOxy();
  counters.wide += 1;
  return null;
};

const SelectedConsumer: React.FC<{ counters: Counters }> = ({ counters }) => {
  useActiveAccount();
  counters.selected += 1;
  return null;
};

const RuntimeCapture: React.FC<{ sink: { seen: unknown[] } }> = ({ sink }) => {
  sink.seen.push(useOxyRuntime());
  return null;
};

function renderProvider(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider baseURL="https://api.oxy.so">{children}</OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe('the provider hands out one stable runtime', () => {
  it('never changes the runtime reference across re-renders', async () => {
    const sink = { seen: [] as unknown[] };
    const view = renderProvider(<RuntimeCapture sink={sink} />);

    await act(async () => {
      view.rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <OxyRuntimeProvider baseURL="https://api.oxy.so">
            <RuntimeCapture sink={sink} />
          </OxyRuntimeProvider>
        </QueryClientProvider>,
      );
    });

    expect(sink.seen.length).toBeGreaterThan(1);
    for (const seen of sink.seen) {
      expect(seen).toBe(sink.seen[0]);
    }
    view.unmount();
  });

  it('throws from useOxyRuntime with no provider mounted', () => {
    const Bare: React.FC = () => {
      useOxyRuntime();
      return null;
    };
    expect(() => render(<Bare />)).toThrow(OxyRuntimeMissingError);
  });

  it('observes each account transition on its own provider, even within one React batch', () => {
    const first = { seen: [] as unknown[] };
    const second = { seen: [] as unknown[] };
    const firstView = renderProvider(<RuntimeCapture sink={first} />);
    const secondView = renderProvider(<RuntimeCapture sink={second} />);
    const firstRuntime = first.seen[0] as OxyRuntime;
    const secondRuntime = second.seen[0] as OxyRuntime;
    expect(firstRuntime).not.toBe(secondRuntime);
    const subjects: Array<string | null> = [];
    const unsubscribe = firstRuntime.subscribe(() => {
      subjects.push(firstRuntime.getSnapshot().account?.id ?? null);
    });
    act(() => {
      firstRuntime.setAccount({ id: 'ana', username: 'ana' } as never);
      firstRuntime.setAccount({ id: 'bo', username: 'bo' } as never);
      firstRuntime.setAccount({ id: 'ana', username: 'ana' } as never);
    });
    expect(subjects).toEqual(['ana', 'bo', 'ana']);
    expect(secondRuntime.getSnapshot().account).toBeNull();
    unsubscribe();
    firstView.unmount();
    secondView.unmount();
  });
});

describe('a selector consumer is not woken by unrelated state', () => {
  it('re-renders the wide useOxy() consumer on a locale change but not the selector one', async () => {
    const counters: Counters = { wide: 0, selected: 0 };
    let setLanguage: ((languageId: string) => Promise<void>) | null = null;

    const Driver: React.FC = () => {
      setLanguage = useOxy().setLanguage;
      return null;
    };

    const view = renderProvider(
      <>
        <Driver />
        <WideConsumer counters={counters} />
        <SelectedConsumer counters={counters} />
      </>,
    );

    // Let the provider settle (storage init, cold boot) before measuring.
    await act(async () => {
      await Promise.resolve();
    });
    const wideBefore = counters.wide;
    const selectedBefore = counters.selected;
    // Vacuity floor: a consumer that never rendered would hold both counters at
    // zero and pass the isolation assertion for the wrong reason.
    expect(wideBefore).toBeGreaterThan(0);
    expect(selectedBefore).toBeGreaterThan(0);

    await act(async () => {
      await setLanguage?.('es-ES');
    });

    // Positive control: the wide value genuinely moved, so this test can fail.
    expect(counters.wide).toBeGreaterThan(wideBefore);
    // The locale is not a session fact, so nothing selecting one saw a change.
    expect(counters.selected).toBe(selectedBefore);
    view.unmount();
  });
});
