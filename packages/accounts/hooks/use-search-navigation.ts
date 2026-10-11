/**
 * Custom hook for managing search navigation and query synchronization
 *
 * Handles navigation to search screen when user starts typing and prevents
 * state updates from router params during active typing sessions.
 *
 * @param pathname - Current route pathname
 * @param router - Expo router instance
 * @param searchInputRef - Ref to the search TextInput
 * @returns Object containing search query state and change handler
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter, usePathname, useLocalSearchParams } from 'expo-router';
import { Platform, type TextInput } from 'react-native';

interface UseSearchNavigationOptions {
  searchInputRef: React.RefObject<TextInput | null>;
}

interface UseSearchNavigationReturn {
  searchQuery: string;
  handleSearchChange: (text: string) => void;
}

const TYPING_DEBOUNCE_MS = 500;
const MAX_FOCUS_ATTEMPTS = 5;
const FOCUS_RETRY_DELAY_MS = 100;
const INITIAL_FOCUS_DELAY_MS = 150;

export function useSearchNavigation({
  searchInputRef,
}: UseSearchNavigationOptions): UseSearchNavigationReturn {
  const router = useRouter();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ q?: string }>();

  const [searchQuery, setSearchQuery] = useState('');
  const hasNavigatedToSearchRef = useRef(false);
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Attempts to focus the search input with retry logic
   * Handles cases where the input isn't immediately available after navigation
   */
  const attemptFocusWithRetry = useCallback(
    (textLength: number, attempt: number = 0): void => {
      if (attempt >= MAX_FOCUS_ATTEMPTS) {
        return;
      }

      requestAnimationFrame(() => {
        setTimeout(
          () => {
            if (!searchInputRef.current) {
              if (attempt < MAX_FOCUS_ATTEMPTS - 1) {
                attemptFocusWithRetry(textLength, attempt + 1);
              }
              return;
            }

            const wasFocused = searchInputRef.current.isFocused();
            searchInputRef.current.focus();

            // Verify focus was successful and restore cursor position
            setTimeout(() => {
              if (!searchInputRef.current) {
                if (attempt < MAX_FOCUS_ATTEMPTS - 1) {
                  attemptFocusWithRetry(textLength, attempt + 1);
                }
                return;
              }

              if (searchInputRef.current.isFocused()) {
                // Restore cursor position once focused (only on native platforms)
                if (
                  Platform.OS !== 'web' &&
                  typeof searchInputRef.current.setNativeProps === 'function'
                ) {
                  try {
                    searchInputRef.current.setNativeProps({
                      selection: { start: textLength, end: textLength },
                    });
                  } catch (error) {
                    // Silently fail if setNativeProps is not available
                    if (__DEV__) {
                      console.warn('[useSearchNavigation] setNativeProps failed:', error);
                    }
                  }
                }
              } else if (!wasFocused && attempt < MAX_FOCUS_ATTEMPTS - 1) {
                // Retry if focus failed
                attemptFocusWithRetry(textLength, attempt + 1);
              }
            }, 50);
          },
          INITIAL_FOCUS_DELAY_MS + attempt * FOCUS_RETRY_DELAY_MS,
        );
      });
    },
    [searchInputRef],
  );

  /**
   * Handles search query changes and manages navigation
   */
  const handleSearchChange = useCallback(
    (text: string) => {
      setSearchQuery(text);

      // Mark as typing and clear previous timeout
      isTypingRef.current = true;
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      // Clear typing flag after debounce period
      typingTimeoutRef.current = setTimeout(() => {
        isTypingRef.current = false;
        typingTimeoutRef.current = null;
      }, TYPING_DEBOUNCE_MS);

      // If already on search screen, update params (including empty string)
      if (pathname === '/(tabs)/search') {
        router.setParams({ q: text || '' });
      } else if (hasNavigatedToSearchRef.current) {
        // If we've already navigated, update params (navigation is in progress)
        // This handles both typing and clearing the input
        router.setParams({ q: text || '' });
      } else if (text.length > 0) {
        // Only navigate once when user starts typing (first character)
        hasNavigatedToSearchRef.current = true;
        isTypingRef.current = true;

        const textLength = text.length;

        // Navigate to search screen
        // router.push() returns void, so use setTimeout for post-navigation focus
        router.push({
          pathname: '/(tabs)/search',
          params: { q: text || '' },
        });

        // Focus input after navigation settles
        setTimeout(() => {
          attemptFocusWithRetry(textLength);
        }, 300);
      }
      // Note: If text is empty and we haven't navigated yet, we don't navigate
      // This prevents navigating to search screen when input is cleared before navigation
    },
    [pathname, router, attemptFocusWithRetry],
  );

  /**
   * Sync router params to local state, but skip during active typing
   */
  useEffect(() => {
    // Skip syncing if user is actively typing to prevent focus loss
    if (isTypingRef.current) {
      return;
    }

    if (pathname === '/(tabs)/search') {
      setSearchQuery(params.q || '');
      hasNavigatedToSearchRef.current = true;
    } else {
      setSearchQuery('');
      hasNavigatedToSearchRef.current = false;
    }
  }, [pathname, params.q]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  return {
    searchQuery,
    handleSearchChange,
  };
}
