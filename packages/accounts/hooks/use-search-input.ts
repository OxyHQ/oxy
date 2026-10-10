/**
 * Custom hook for managing search input state with focus preservation
 *
 * Prevents focus loss during navigation and state updates by maintaining
 * local state that only syncs with props when the input is not focused.
 *
 * @param searchQuery - The current search query from parent component
 * @param onSearchChange - Callback to notify parent of search changes
 * @param searchInputRef - Ref to the TextInput component
 * @returns Object containing local search state and handlers
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform, type TextInput } from 'react-native';

interface UseSearchInputOptions {
  searchQuery: string;
  onSearchChange: (text: string) => void;
  searchInputRef?: React.RefObject<TextInput | null>;
  isSearchScreen: boolean;
}

interface UseSearchInputReturn {
  localSearchQuery: string;
  handleSearchChange: (text: string) => void;
  handleSearchFocus: () => void;
  handleSearchBlur: () => void;
}

const FOCUS_RESTORE_DELAY_MS = 200;
const MAX_FOCUS_ATTEMPTS = 5;
const FOCUS_RETRY_DELAY_MS = 100;

export function useSearchInput({
  searchQuery,
  onSearchChange,
  searchInputRef,
  isSearchScreen,
}: UseSearchInputOptions): UseSearchInputReturn {
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
  const isFocusedRef = useRef<boolean>(false);
  const shouldFocusAfterNavigationRef = useRef<boolean>(false);

  // Sync searchQuery prop to local state only when input is not focused
  useEffect(() => {
    if (!isFocusedRef.current) {
      setLocalSearchQuery(searchQuery);
    }
  }, [searchQuery]);

  // Focus input after navigating to search screen if user was typing
  useEffect(() => {
    if (isSearchScreen && shouldFocusAfterNavigationRef.current && searchInputRef?.current) {
      shouldFocusAfterNavigationRef.current = false;

      const attemptFocus = (attempt: number = 0): void => {
        if (attempt >= MAX_FOCUS_ATTEMPTS) {
          return;
        }

        requestAnimationFrame(() => {
          setTimeout(
            () => {
              if (!searchInputRef.current) {
                if (attempt < MAX_FOCUS_ATTEMPTS - 1) {
                  attemptFocus(attempt + 1);
                }
                return;
              }

              searchInputRef.current.focus();

              // Verify focus and restore cursor position (only on native platforms)
              setTimeout(() => {
                if (searchInputRef.current?.isFocused()) {
                  const length = localSearchQuery.length;
                  // setNativeProps is not available on web
                  if (
                    Platform.OS !== 'web' &&
                    typeof searchInputRef.current.setNativeProps === 'function'
                  ) {
                    try {
                      searchInputRef.current.setNativeProps({
                        selection: { start: length, end: length },
                      });
                    } catch (error) {
                      // Silently fail if setNativeProps is not available
                      if (__DEV__) {
                        console.warn('[useSearchInput] setNativeProps failed:', error);
                      }
                    }
                  }
                } else if (attempt < MAX_FOCUS_ATTEMPTS - 1) {
                  attemptFocus(attempt + 1);
                }
              }, 50);
            },
            FOCUS_RESTORE_DELAY_MS + attempt * FOCUS_RETRY_DELAY_MS,
          );
        });
      };

      attemptFocus();
    }
  }, [isSearchScreen, localSearchQuery, searchInputRef]);

  const handleSearchChange = useCallback(
    (text: string) => {
      setLocalSearchQuery(text);
      onSearchChange(text);

      // Mark that we should focus after navigation if typing on non-search screen
      if (!isSearchScreen && text.length > 0) {
        shouldFocusAfterNavigationRef.current = true;
      }
    },
    [onSearchChange, isSearchScreen],
  );

  const handleSearchFocus = useCallback(() => {
    isFocusedRef.current = true;
    shouldFocusAfterNavigationRef.current = false;
  }, []);

  const handleSearchBlur = useCallback(() => {
    isFocusedRef.current = false;

    // Sync final value when blurring if it differs
    if (localSearchQuery !== searchQuery) {
      onSearchChange(localSearchQuery);
    }
  }, [localSearchQuery, searchQuery, onSearchChange]);

  return {
    localSearchQuery,
    handleSearchChange,
    handleSearchFocus,
    handleSearchBlur,
  };
}
