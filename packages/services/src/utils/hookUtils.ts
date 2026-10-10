/**
 * React hook utilities for common patterns and state management
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// Platform detection for SSR/Node.js/React Native safety
const isBrowser = typeof window !== 'undefined';
const hasLocalStorage = isBrowser && typeof window.localStorage !== 'undefined';
const hasSessionStorage = isBrowser && typeof window.sessionStorage !== 'undefined';
const hasNavigator = typeof navigator !== 'undefined';

/**
 * Hook for managing async operations with loading, error, and data states
 */
export function useAsync<T>(
  asyncFn: () => Promise<T>,
  deps: React.DependencyList = []
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await asyncFn();
      setData(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      throw error;
    } finally {
      setLoading(false);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: asyncFn is intentionally excluded — this is a mount-only pattern where the callback identity should not cause re-creation
  }, deps);

  return { data, loading, error, execute };
}

/**
 * Hook for managing async operations that execute on mount
 */
export function useAsyncEffect<T>(
  asyncFn: () => Promise<T>,
  deps: React.DependencyList = []
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    const execute = async () => {
      try {
        const result = await asyncFn();
        if (mounted) {
          setData(result);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          const error = err instanceof Error ? err : new Error(String(err));
          setError(error);
          setLoading(false);
        }
      }
    };

    execute();

    return () => {
      mounted = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: asyncFn is intentionally excluded — this is a mount-only pattern where the callback identity should not trigger re-execution
  }, deps);

  return { data, loading, error };
}

/**
 * Hook for debounced values
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

/**
 * Hook for throttled values
 */
export function useThrottle<T>(value: T, delay: number): T {
  const [throttledValue, setThrottledValue] = useState<T>(value);
  const lastRun = useRef(Date.now());

  useEffect(() => {
    const handler = setTimeout(() => {
      if (Date.now() - lastRun.current >= delay) {
        setThrottledValue(value);
        lastRun.current = Date.now();
      }
    }, delay - (Date.now() - lastRun.current));

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return throttledValue;
}

/**
 * Hook for previous value
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  
  useEffect(() => {
    ref.current = value;
  });
  
  return ref.current;
}

/**
 * Hook for boolean state with toggle
 */
export function useToggle(initialValue = false) {
  const [value, setValue] = useState(initialValue);
  
  const toggle = useCallback(() => setValue(v => !v), []);
  const setTrue = useCallback(() => setValue(true), []);
  const setFalse = useCallback(() => setValue(false), []);
  
  return { value, toggle, setTrue, setFalse, setValue };
}

/**
 * Hook for counter state
 */
export function useCounter(initialValue = 0) {
  const [count, setCount] = useState(initialValue);
  
  const increment = useCallback(() => setCount(c => c + 1), []);
  const decrement = useCallback(() => setCount(c => c - 1), []);
  const reset = useCallback(() => setCount(initialValue), [initialValue]);
  const setValue = useCallback((value: number) => setCount(value), []);
  
  return { count, increment, decrement, reset, setValue };
}

/**
 * Hook for local storage (platform-safe)
 */
export function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (!hasLocalStorage) return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      // Silently fail and return initial value
      return initialValue;
    }
  });

  const setValue = useCallback((value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      if (hasLocalStorage) {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch {
      // Silently fail - storage might be full or blocked
    }
  }, [key, storedValue]);

  return [storedValue, setValue] as const;
}

/**
 * Hook for session storage (platform-safe)
 */
export function useSessionStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (!hasSessionStorage) return initialValue;
    try {
      const item = window.sessionStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      // Silently fail and return initial value
      return initialValue;
    }
  });

  const setValue = useCallback((value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      if (hasSessionStorage) {
        window.sessionStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch {
      // Silently fail - storage might be full or blocked
    }
  }, [key, storedValue]);

  return [storedValue, setValue] as const;
}

/**
 * Hook for window size (platform-safe)
 */
export function useWindowSize() {
  const [windowSize, setWindowSize] = useState({
    width: isBrowser ? window.innerWidth : 0,
    height: isBrowser ? window.innerHeight : 0,
  });

  useEffect(() => {
    if (!isBrowser) return;

    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return windowSize;
}

/**
 * Hook for scroll position (platform-safe)
 */
export function useScrollPosition() {
  const [scrollPosition, setScrollPosition] = useState(0);

  useEffect(() => {
    if (!isBrowser) return;

    const handleScroll = () => {
      setScrollPosition(window.pageYOffset);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return scrollPosition;
}

/**
 * Hook for online/offline status (platform-safe)
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(hasNavigator ? navigator.onLine : true);

  useEffect(() => {
    if (!isBrowser) return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

/**
 * Hook for media queries (platform-safe)
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (!isBrowser) return;

    const media = window.matchMedia(query);
    if (media.matches !== matches) {
      setMatches(media.matches);
    }

    const listener = () => setMatches(media.matches);
    media.addEventListener('change', listener);

    return () => media.removeEventListener('change', listener);
  }, [matches, query]);

  return matches;
}

/**
 * Hook for keyboard events (platform-safe)
 */
export function useKeyPress(targetKey: string): boolean {
  const [keyPressed, setKeyPressed] = useState(false);

  useEffect(() => {
    if (!isBrowser) return;

    const downHandler = ({ key }: KeyboardEvent) => {
      if (key === targetKey) {
        setKeyPressed(true);
      }
    };

    const upHandler = ({ key }: KeyboardEvent) => {
      if (key === targetKey) {
        setKeyPressed(false);
      }
    };

    window.addEventListener('keydown', downHandler);
    window.addEventListener('keyup', upHandler);

    return () => {
      window.removeEventListener('keydown', downHandler);
      window.removeEventListener('keyup', upHandler);
    };
  }, [targetKey]);

  return keyPressed;
}

/**
 * Hook for click outside detection (platform-safe)
 */
export function useClickOutside(ref: React.RefObject<HTMLElement>, handler: () => void) {
  useEffect(() => {
    if (!isBrowser) return;

    const listener = (event: MouseEvent | TouchEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) {
        return;
      }
      handler();
    };

    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);

    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler]);
}

/**
 * Hook for form validation
 */
export function useFormValidation<T extends Record<string, unknown>>(
  initialValues: T,
  validationSchema: (values: T) => Partial<Record<keyof T, string>>
) {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<keyof T, boolean>>>({});

  const validate = useCallback((valuesToValidate: T) => {
    return validationSchema(valuesToValidate);
  }, [validationSchema]);

  const setValue = useCallback((field: keyof T, value: T[keyof T]) => {
    setValues(prev => ({ ...prev, [field]: value }));
    if (touched[field]) {
      const newErrors = validate({ ...values, [field]: value });
      setErrors(prev => ({ ...prev, [field]: newErrors[field] }));
    }
  }, [values, touched, validate]);

  const setTouchedField = useCallback((field: keyof T) => {
    setTouched(prev => ({ ...prev, [field]: true }));
    const newErrors = validate(values);
    setErrors(prev => ({ ...prev, [field]: newErrors[field] }));
  }, [values, validate]);

  const isValid = useMemo(() => {
    const validationErrors = validate(values);
    return Object.keys(validationErrors).length === 0;
  }, [values, validate]);

  return {
    values,
    errors,
    touched,
    isValid,
    setValue,
    setTouchedField,
    setValues,
    setErrors,
    setTouched
  };
} 