import React from 'react';
import { View } from 'react-native';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Text } from '@oxy.so/bloom/typography';
import { DISPLAY_CURRENCIES, useDisplayCurrency } from '../hooks/useDisplayCurrency';
import { useI18n } from '../hooks/useI18n';

export function DisplayCurrencySelector() {
  const { currency, selectCurrency, isSaving, error } = useDisplayCurrency();
  const { t } = useI18n();
  return (
    <View>
      <Text>{t('preferences.displayCurrency.label')}</Text>
      <SegmentedControl
        type="radio"
        label={t('preferences.displayCurrency.label')}
        value={currency}
        onValueChange={(value) => {
          const selected = DISPLAY_CURRENCIES.find((item) => item === value);
          if (selected && !isSaving) selectCurrency(selected);
        }}
      >
        {DISPLAY_CURRENCIES.map((value) => (
          <SegmentedControlItem key={value} value={value} disabled={isSaving}>
            <SegmentedControlItemText>{value}</SegmentedControlItemText>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      {error && (
        <Text accessibilityLiveRegion="polite">{t('preferences.displayCurrency.saveFailed')}</Text>
      )}
    </View>
  );
}
