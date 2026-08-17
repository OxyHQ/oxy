import React, { useState, useCallback } from 'react';
import {
    View,
    StyleSheet,
} from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { toast } from '@oxyhq/bloom/toast';
import { surfaces } from '@oxyhq/bloom/surfaces';
import { useTheme } from '@oxyhq/bloom/theme';
import { H4, Text } from '@oxyhq/bloom/typography';
import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { IconCircle } from '@oxyhq/bloom/icon-circle';
import { BenefitList, BenefitRow } from '@oxyhq/bloom/benefit-list';
import * as Icons from '@oxyhq/bloom/icons';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';

const AccountVerificationScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
}) => {
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
            toast.error(t('accountVerification.reasonRequired') || 'Please provide a reason for verification');
            return;
        }

        if (!oxyServices) {
            toast.error(t('accountVerification.error') || 'Service not available');
            return;
        }

        setIsSubmitting(true);
        try {
            const result = await oxyServices.requestAccountVerification(
                reason.trim(),
                evidence.trim() || undefined
            );

            // Acknowledgement surface — dismiss (button OR backdrop) resets and
            // returns; there is no negative action.
            await surfaces.confirm({
                title: t('accountVerification.successTitle') || 'Request Submitted',
                description:
                    t('accountVerification.successMessage') || `Your verification request has been submitted. Request ID: ${result.requestId}`,
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
                (error instanceof Error ? error.message : null) || t('accountVerification.submitError') || 'Failed to submit verification request'
            );
        } finally {
            setIsSubmitting(false);
        }
    }, [reason, evidence, oxyServices, t, goBack]);

    const canSubmit = Boolean(reason.trim()) && !isSubmitting;

    return (
        <>

            <View className="px-screen-margin pb-space-32">
                {/* Hero */}
                <View className="items-center py-space-24 gap-space-12">
                    <IconCircle icon={Icons.Verified_Stroke2_Corner2_Rounded} />
                    <H4 className="text-headerBold font-headerBold text-text text-center">
                        {t('accountVerification.heroTitle') || 'Get a verified badge'}
                    </H4>
                    <Text className="font-sans text-body text-text-secondary text-center">
                        {t('accountVerification.description') || 'Request a verified badge for your account. Verified accounts help establish authenticity and credibility.'}
                    </Text>
                </View>

                {/* Benefits */}
                <BenefitList
                    className="mb-space-24"
                    accessibilityLabel={t('accountVerification.sections.benefits') || 'What verification gives you'}
                >
                    <BenefitRow
                        icon={<Icons.ShieldCheck_Stroke2_Corner0_Rounded size="sm" style={{ color: bloomTheme.colors.primary }} />}
                        label={t('accountVerification.benefits.authenticity') || 'Confirms your identity is authentic and trusted'}
                    />
                    <BenefitRow
                        icon={<Icons.Verified_Stroke2_Corner2_Rounded size="sm" style={{ color: bloomTheme.colors.primary }} />}
                        label={t('accountVerification.benefits.badge') || 'Displays a verified badge across the platform'}
                    />
                    <BenefitRow
                        icon={<Icons.Sparkle_Stroke2_Corner0_Rounded size="sm" style={{ color: bloomTheme.colors.primary }} />}
                        label={t('accountVerification.benefits.credibility') || 'Builds credibility with people who follow you'}
                    />
                </BenefitList>

                {/* Verification request form */}
                <Text className="text-sectionTitle font-sectionTitle text-text-secondary mb-space-12">
                    {t('accountVerification.sections.request') || 'VERIFICATION REQUEST'}
                </Text>

                <View className="gap-space-16 p-space-16 rounded-radius-20 bg-fill">
                    <TextField>
                        <TextFieldInput
                            floatingLabel
                            label={t('accountVerification.reasonLabel') || 'Reason for Verification *'}
                            value={reason}
                            onChangeText={setReason}
                            placeholder={t('accountVerification.reasonPlaceholder') || 'Explain why you need a verified badge (e.g., public figure, brand, organization)'}
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
                            placeholder={t('accountVerification.evidencePlaceholder') || 'Provide any supporting documentation or links (e.g., official website, social media profiles)'}
                            multiline
                            numberOfLines={4}
                            textAlignVertical="top"
                            editable={!isSubmitting}
                            style={styles.multiline}
                        />
                    </TextField>
                </View>

                <Button
                    variant="primary"
                    size="large"
                    fullWidth
                    className="mt-space-24"
                    onPress={handleSubmit}
                    disabled={!canSubmit}
                    loading={isSubmitting}
                    accessibilityLabel={t('accountVerification.submit') || 'Submit Request'}
                >
                    {t('accountVerification.submit') || 'Submit Request'}
                </Button>

                <View className="flex-row items-start gap-space-8 mt-space-24">
                    <Icons.CircleInfo_Stroke2_Corner0_Rounded
                        size="sm"
                        style={{ color: bloomTheme.colors.textTertiary }}
                    />
                    <Text className="flex-1 font-sans text-caption text-text-tertiary">
                        {t('accountVerification.note') || 'Note: Verification requests are reviewed manually and may take several days. We will notify you once your request has been reviewed.'}
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
    multiline: {
        minHeight: 96,
    },
});

export default React.memo(AccountVerificationScreen);
