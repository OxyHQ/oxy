import { useId } from 'react';
import type { Locale } from '@/lib/i18n';
import { LOCALE_LABELS, SUPPORTED_LOCALES, useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Compact language picker for the Console.
 *
 * Native `<select>` keeps the picker lightweight, fully keyboard-
 * accessible and OS-native on mobile without pulling in extra Radix
 * or Base UI dependencies for what is essentially a one-line control.
 */
export function LanguagePicker({ className }: { className?: string }) {
  const { t, locale, setLocale } = useTranslation();
  const id = useId();

  return (
    <div className={cn('inline-flex items-center gap-2 text-sm', className)}>
      <label htmlFor={id} className="text-muted-foreground">
        {t('language.picker.label')}
      </label>
      <select
        id={id}
        value={locale}
        aria-label={t('language.picker.ariaLabel')}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className={cn(
          'rounded-md border border-input bg-background px-2 py-1',
          'text-sm focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-ring focus-visible:ring-offset-1',
          'cursor-pointer',
        )}
      >
        {SUPPORTED_LOCALES.map((value) => (
          <option key={value} value={value}>
            {LOCALE_LABELS[value]}
          </option>
        ))}
      </select>
    </div>
  );
}
