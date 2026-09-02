import { createContext, useContext, useMemo, useRef, type PropsWithChildren } from 'react';
import type { TextInput } from 'react-native';

type SearchFocusValue = {
  /**
   * Callback ref the search input registers itself through. Passed straight to
   * `SearchHeader`'s `ref`, so it fires during commit as the input mounts and
   * again with `null` as it unmounts — no effect and no manual cleanup.
   */
  registerInput: (node: TextInput | null) => void;
  /** Focus the registered search input. A no-op when none is mounted. */
  focusInput: () => void;
};

const SearchFocusContext = createContext<SearchFocusValue | null>(null);

/**
 * Lets the tab bar focus the search screen's input.
 *
 * The two are far apart in the tree — the bar is rendered by the navigator,
 * the input by a tab screen — and a ref cannot be threaded between them, so
 * this holds the input node in one place both can reach.
 *
 * Mounted around the whole tab navigator so it is an ancestor of the bar AND
 * of every screen; the bar is rendered inside `BottomTabView`, which is a
 * descendant of `<Tabs>`, so wrapping `<Tabs>` covers both.
 *
 * The value is memoized once with an empty dependency list: it closes over a
 * ref rather than state, so its identity never needs to change and consumers
 * never re-render because of it.
 */
export function SearchFocusProvider({ children }: PropsWithChildren) {
  const inputRef = useRef<TextInput | null>(null);

  const value = useMemo<SearchFocusValue>(
    () => ({
      registerInput: (node) => {
        inputRef.current = node;
      },
      focusInput: () => {
        inputRef.current?.focus();
      },
    }),
    [],
  );

  return <SearchFocusContext.Provider value={value}>{children}</SearchFocusContext.Provider>;
}

SearchFocusProvider.displayName = 'SearchFocusProvider';

export function useSearchFocus(): SearchFocusValue {
  const context = useContext(SearchFocusContext);
  if (context === null) {
    throw new Error('useSearchFocus must be used within a SearchFocusProvider');
  }
  return context;
}
