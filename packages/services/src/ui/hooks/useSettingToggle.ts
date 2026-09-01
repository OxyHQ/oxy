import { useState, useCallback, useEffect } from 'react';
import { toast } from '@oxyhq/bloom/toast';

interface UseSettingToggleOptions {
    /** Initial value of the setting */
    initialValue: boolean;
    /** Function to save the setting to the server */
    onSave: (value: boolean) => Promise<void>;
    /** Success message when saving */
    successMessage?: string;
    /** Error message when save fails */
    errorMessage?: string;
    /** Whether to revert on error (default: true) */
    revertOnError?: boolean;
    /** Whether to show success toast (default: false) */
    showSuccessToast?: boolean;
}

interface UseSettingToggleReturn {
    /** Current value */
    value: boolean;
    /** Whether the setting is being saved */
    isSaving: boolean;
    /** Toggle the setting (optimistic update with revert on error) */
    toggle: () => Promise<void>;
    /** Set the value directly */
    setValue: (value: boolean) => void;
}

/**
 * Hook for handling boolean toggle settings with optimistic updates.
 * Automatically reverts to the previous value if the save fails.
 *
 * @example
 * const { value, toggle, isSaving } = useSettingToggle({
 *   initialValue: user.notificationsEnabled,
 *   onSave: (value) => api.updateNotifications(value),
 *   errorMessage: 'Failed to update notifications',
 * });
 *
 * <Switch value={value} onValueChange={toggle} disabled={isSaving} />
 */
export function useSettingToggle(options: UseSettingToggleOptions): UseSettingToggleReturn {
    const {
        initialValue,
        onSave,
        successMessage,
        errorMessage = 'Failed to save setting',
        revertOnError = true,
        showSuccessToast = false,
    } = options;

    const [value, setValue] = useState(initialValue);
    const [isSaving, setIsSaving] = useState(false);

    // Update value when initialValue changes (e.g., from server)
    useEffect(() => {
        setValue(initialValue);
    }, [initialValue]);

    const toggle = useCallback(async () => {
        const previousValue = value;
        const newValue = !value;

        // Optimistic update
        setValue(newValue);
        setIsSaving(true);

        try {
            await onSave(newValue);

            if (showSuccessToast && successMessage) {
                toast.success(successMessage);
            }
        } catch (err: unknown) {
            // Revert on error
            if (revertOnError) {
                setValue(previousValue);
            }

            toast.error(errorMessage || (err instanceof Error ? err.message : null) || 'An error occurred');
        } finally {
            setIsSaving(false);
        }
    }, [value, onSave, successMessage, errorMessage, revertOnError, showSuccessToast]);

    return { value, isSaving, toggle, setValue };
}

/**
 * Hook for managing multiple toggle settings at once.
 * Useful when you have several related boolean settings.
 */
export function useSettingToggles<T extends { [K in keyof T]: boolean }>(options: {
    initialValues: T;
    onSave: (key: keyof T, value: boolean) => Promise<void>;
    errorMessage?: string | ((key: keyof T) => string);
    revertOnError?: boolean;
}): {
    values: T;
    savingKeys: Set<keyof T>;
    toggle: (key: keyof T) => Promise<void>;
    setValues: (values: Partial<T>) => void;
} {
    const { initialValues, onSave, errorMessage = 'Failed to save setting', revertOnError = true } = options;

    const [values, setValues] = useState<T>(initialValues);
    const [savingKeys, setSavingKeys] = useState<Set<keyof T>>(new Set());

    // Update values when initialValues change
    useEffect(() => {
        setValues(initialValues);
    }, [initialValues]);

    const toggle = useCallback(async (key: keyof T) => {
        const previousValue = values[key];
        const newValue = !previousValue;

        // Optimistic update
        setValues(prev => ({ ...prev, [key]: newValue }));
        setSavingKeys(prev => new Set(prev).add(key));

        try {
            await onSave(key, newValue);
        } catch (err: unknown) {
            // Revert on error
            if (revertOnError) {
                setValues(prev => ({ ...prev, [key]: previousValue }));
            }

            const message = typeof errorMessage === 'function'
                ? errorMessage(key)
                : errorMessage;
            toast.error(message || (err instanceof Error ? err.message : null) || 'An error occurred');
        } finally {
            setSavingKeys(prev => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        }
    }, [values, onSave, errorMessage, revertOnError]);

    const setValuesExternal = useCallback((newValues: Partial<T>) => {
        setValues(prev => ({ ...prev, ...newValues }));
    }, []);

    return { values, savingKeys, toggle, setValues: setValuesExternal };
}

export default useSettingToggle;
