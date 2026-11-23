import React, { useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { toast } from '@oxy.so/bloom/toast';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { H4, Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { BenefitList, BenefitRow } from '../components/BenefitList';
// Per glyph, never `@oxy.so/bloom/icons`. That barrel re-exports all 461 Remix
// glyphs and Metro does not tree-shake, so one import of it here re-ships every
// glyph — 313,123 B, measured — to every app in this package's graph, and no
// consumer can opt out of what a dependency asks for.
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiVerifiedBadgeLine } from '@oxy.so/bloom/icons/RiVerifiedBadgeLine';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/oxyRuntimeContext';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const AccountVerificationScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => {
  const themed = useThemedStyles();
  // Use useOxy() hook for OxyContext values
  const { oxyServices } = useOxy();
  const { t } = useI18n();

  useSurfaceHeader({ title: t('accountVerification.title') || 'Account Verification' });
  const bloomTheme = useTheme();

  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!reason.trim()) {
      toast.error(
        t('accountVerification.reasonRequired') || 'Please provide a reason for verification',
      );
      return;
    }

    if (!oxyServices) {
      toast.error(t('accountVerification.error') || 'Service not available');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await oxyServices.users.requestVerification(
        reason.trim(),
        evidence.trim() || undefined,
      );

      // Acknowledgement surface — dismiss (button OR backdrop) resets and
      // returns; there is no negative action.
      await surfaces.confirm({
        title: t('accountVerification.successTitle') || 'Request Submitted',
        description:
          t('accountVerification.successMessage') ||
          `Your verification request has been submitted. Request ID: ${result.requestId}`,
        confirmLabel: t('accountVerification.ok') || 'OK',
        hideCancel: true,
      });
      setReason('');
      setEvidence('');
      goBack?.();
    } catch (error: unknown) {
      if (__DEV__) {
        console.error('Failed to submit verification request:', error);
      }
      toast.error(
        (error instanceof Error ? error.message : null) ||
          t('accountVerification.submitError') ||
          'Failed to submit verification request',
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [reason, evidence, oxyServices, t, goBack]);

  const canSubmit = Boolean(reason.trim()) && !isSubmitting;

  return (
    <>
      <View style={styles.section}>
        {/* Hero */}
        <View style={styles.container}>
          <IconCircle icon={RiVerifiedBadgeLine} />
          <Text role="heading" aria-level={4} style={themed.title}>
            {t('accountVerification.heroTitle') || 'Get a verified badge'}
          </Text>
          <Text style={themed.mutedText}>
            {t('accountVerification.description') ||
              'Request a verified badge for your account. Verified accounts help establish authenticity and credibility.'}
          </Text>
        </View>

        {/* Benefits */}
        <BenefitList
          style={styles.benefits}
          accessibilityLabel={
            t('accountVerification.sections.benefits') || 'What verification gives you'
          }
        >
          <BenefitRow
            icon={<RiShieldCheckLine size="sm" style={{ color: bloomTheme.colors.primary }} />}
            label={
              t('accountVerification.benefits.authenticity') ||
              'Confirms your identity is authentic and trusted'
            }
          />
          <BenefitRow
            icon={<RiVerifiedBadgeLine size="sm" style={{ color: bloomTheme.colors.primary }} />}
            label={
              t('accountVerification.benefits.badge') ||
              'Displays a verified badge across the platform'
            }
          />
          <BenefitRow
            icon={<RiSparklingLine size="sm" style={{ color: bloomTheme.colors.primary }} />}
            label={
              t('accountVerification.benefits.credibility') ||
              'Builds credibility with people who follow you'
            }
          />
        </BenefitList>

        {/* Verification request form */}
        <Text style={themed.mutedText2}>
          {t('accountVerification.sections.request') || 'VERIFICATION REQUEST'}
        </Text>

        <View style={themed.surface}>
          <TextField>
            <TextFieldInput
              floatingLabel
              label={t('accountVerification.reasonLabel') || 'Reason for Verification *'}
              value={reason}
              onChangeText={setReason}
              placeholder={
                t('accountVerification.reasonPlaceholder') ||
                'Explain why you need a verified badge (e.g., public figure, brand, organization)'
              }
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              editable={!isSubmitting}
              style={styles.multiline}
            />
          </TextField>

          <TextField>
            <TextFieldInput
              floatingLabel
              label={t('accountVerification.evidenceLabel') || 'Evidence (Optional)'}
              value={evidence}
              onChangeText={setEvidence}
              placeholder={
                t('accountVerification.evidencePlaceholder') ||
                'Provide any supporting documentation or links (e.g., official website, social media profiles)'
              }
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              editable={!isSubmitting}
              style={styles.multiline}
            />
          </TextField>
        </View>

        <Button
          appearance="solid"
          tone="accent"
          size="lg"
          fullWidth
          style={styles.button}
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={isSubmitting}
          accessibilityLabel={t('accountVerification.submit') || 'Submit Request'}
        >
          {t('accountVerification.submit') || 'Submit Request'}
        </Button>

        <View style={styles.row}>
          <RiInformationLine size="sm" style={{ color: bloomTheme.colors.textTertiary }} />
          <Text style={themed.mutedText3}>
            {t('accountVerification.note') ||
              'Note: Verification requests are reviewed manually and may take several days. We will notify you once your request has been reviewed.'}
          </Text>
        </View>
      </View>
    </>
  );
};

// Measured layout only (no color): give the multiline inputs a comfortable
// minimum height so the floating-label textarea has room. Colors/typography
// come from the Bloom TextFieldInput chrome + token classes.
const styles = StyleSheet.create({
  benefits: { marginBottom: 24 },
  multiline: {
    minHeight: 96,
  },

  section: { paddingHorizontal: 20, paddingBottom: 32 },
  container: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  button: { marginTop: 24 },
  row: { marginTop: 24, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
});

export default React.memo(AccountVerificationScreen);

const useThemedStyles = createTokenStyles((t) => ({
  title: {
    textAlign: 'center',
    fontSize: 28,
    color: t.foreground,
    lineHeight: 34,
    fontWeight: 700,
  },
  mutedText: { textAlign: 'center', color: t.mutedForeground, lineHeight: 22, fontWeight: 400 },
  mutedText2: {
    marginBottom: 12,
    fontSize: 20,
    color: t.mutedForeground,
    lineHeight: 26,
    fontWeight: 600,
  },
  surface: { gap: 16, borderRadius: 20, backgroundColor: t.card, padding: 16 },
  mutedText3: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    color: t.mutedForeground,
    lineHeight: 14,
    fontWeight: 400,
  },
}));
