import React, { useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, Platform, Linking } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { toast } from '@oxyhq/bloom';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { FAIRCOIN_WALLET_URL } from '@/constants/payments';
import faircoinImage from '@/assets/images/faircoin.jpg';

/**
 * Promotional banner inviting the user to install the FAIRWallet / FairCoin
 * wallet app. Tapping the CTA opens {@link FAIRCOIN_WALLET_URL} in the system
 * browser; a failed open surfaces a localized toast.
 */
export function FairCoinBanner() {
  const colors = useColors();
  const { t } = useTranslation();

  const handleInstallFairCoinWallet = useCallback(() => {
    Linking.openURL(FAIRCOIN_WALLET_URL).catch(() => {
      toast.error(t('payments.fairCoinBanner.openMessage'));
    });
  }, [t]);

  const storeButtonLabel = Platform.OS === 'ios'
    ? t('payments.fairCoinBanner.appStore')
    : Platform.OS === 'android'
      ? t('payments.fairCoinBanner.playStore')
      : t('payments.fairCoinBanner.download');

  return (
    <View style={[styles.faircoinBanner, { backgroundColor: colors.brandFairCoinBackground }]}>
      <View style={styles.faircoinBannerContent}>
        <Image
          source={faircoinImage}
          style={styles.faircoinBannerImage}
          resizeMode="contain"
        />

        <View style={styles.faircoinBannerRightContainer}>
          <View style={styles.faircoinBannerTextContainer}>
            <Text style={[styles.faircoinBannerTitle, { color: colors.brandFairCoinAccent }]}>
              {t('payments.fairCoinBanner.title')}
            </Text>
            <Text style={styles.faircoinBannerDescription}>
              {t('payments.fairCoinBanner.description')}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.faircoinBannerButton, { backgroundColor: colors.brandFairCoinAccent }]}
            onPress={handleInstallFairCoinWallet}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.openStore')}
            accessibilityHint={t('a11y.openStoreHint')}
          >
            <MaterialCommunityIcons
              name={Platform.OS === 'ios' ? 'apple' : Platform.OS === 'android' ? 'google-play' : 'download'}
              size={18}
              color="#1A1A1A"
            />
            <Text style={styles.faircoinBannerButtonText}>
              {storeButtonLabel}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  faircoinBanner: {
    borderRadius: 24,
    marginBottom: 24,
    overflow: 'hidden',
  },
  faircoinBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    minHeight: 70,
    flexWrap: 'wrap',
  },
  faircoinBannerImage: {
    width: 90,
    height: 70,
    marginRight: 10,
    flexShrink: 0,
  },
  faircoinBannerRightContainer: {
    flex: 1,
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  faircoinBannerTextContainer: {
    flex: 1,
    minWidth: 200,
    justifyContent: 'center',
  },
  faircoinBannerTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 3,
  },
  faircoinBannerDescription: {
    fontSize: 15,
    color: '#FFFFFF',
    opacity: 0.9,
    lineHeight: 20,
  },
  faircoinBannerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    gap: 6,
    flexShrink: 0,
  },
  faircoinBannerButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1A1A1A',
  },
});
