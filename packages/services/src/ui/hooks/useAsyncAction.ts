import { useState, useCallback } from 'react';
import { toast } from '@oxyhq/bloom/toast';

interface UseAsyncActionOptions<T> {
    /** Function to execute */
    action: () => Promise<T>;
    /** Success message to display */
    successMessage?: string;
    /** Error message to display (or function to get message from error) */
    errorMessage?: string | ((error: unknown) => string);
    /** Callback on success */
    onSuccess?: (result: T) => void;
    /** Callback on error */
    onError?: (error: unknown) => void;
    /** Show loading toast */
    showLoadingToast?: boolean;
    /** Loading message */
    loadingMessage?: string;
}

interface UseAsyncActionReturn<T> {
    /** Execute the action */
    execute: () => Promise<T | undefined>;
    /** Whether the action is currently executing */
    isLoading: boolean;
    /** The last error that occurred */
    error: Error | null;
    /** Reset the error state */
    resetError: () => void;
}

/**
 * Hook for handling async actions with loading state, error handling, and toast notifications.
 * Reduces boilerplate for common patterns like try-catch with toast feedback.
 *
 * @example
 * const { execute, isLoading } = useAsyncAction({
 *   action: () => api.saveSettings(settings),
 *   successMessage: 'Settings saved!',
 *   errorMessage: 'Failed to save settings',
 * });
 *
 * <Button onPress={execute} disabled={isLoading}>Save</Button>
 */
export function useAsyncAction<T = void>(
    options: UseAsyncActionOptions<T>
): UseAsyncActionReturn<T> {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const execute = useCallback(async (): Promise<T | undefined> => {
        const {
            action,
            successMessage,
            errorMessage,
            onSuccess,
            onError,
            showLoadingToast,
            loadingMessage,
        } = options;

        setIsLoading(true);
        setError(null);

        if (showLoadingToast && loadingMessage) {
            toast.info(loadingMessage);
        }

        try {
            const result = await action();

            if (successMessage) {
                toast.success(successMessage);
            }

            onSuccess?.(result);
            return result;
        } catch (err: unknown) {
            const message = typeof errorMessage === 'function'
                ? errorMessage(err)
                : errorMessage || (err instanceof Error ? err.message : null) || 'An error occurred';

            toast.error(message);
            setError(err instanceof Error ? err : new Error(message));
            onError?.(err);
            return undefined;
        } finally {
            setIsLoading(false);
        }
    }, [options]);

    const resetError = useCallback(() => {
        setError(null);
    }, []);

    return { execute, isLoading, error, resetError };
}

/**
 * Simplified version that just executes an async action with toast feedback.
 * Useful for one-off actions.
 */
export async function executeWithToast<T>(
    action: () => Promise<T>,
    options?: {
        successMessage?: string;
        errorMessage?: string;
        loadingMessage?: string;
    }
): Promise<T | undefined> {
    const { successMessage, errorMessage, loadingMessage } = options || {};

    if (loadingMessage) {
        toast.info(loadingMessage);
    }

    try {
        const result = await action();
        if (successMessage) {
            toast.success(successMessage);
        }
        return result;
    } catch (err: unknown) {
        toast.error(errorMessage || (err instanceof Error ? err.message : null) || 'An error occurred');
        return undefined;
    }
}

export default useAsyncAction;
