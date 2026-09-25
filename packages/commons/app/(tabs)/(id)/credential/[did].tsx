import React, { useCallback, useMemo, useState } from 'react';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import { Admonition } from '@oxy.so/bloom/admonition';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Icons } from '@/constants/icons';
import { fullWidthControl } from '@/constants/styles';
import { Button } from '@oxy.so/bloom/button';
import { View, Text, StyleSheet, Image, TextInput, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import {
  Screen,
  StackHeader,
  Section,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
import { useCivicCard } from '@/hooks/useCivicCard';
import { useIssueCredential } from '@/hooks/useIssueCredential';
import { userIdFromDid } from '@/lib/civic/did';
import {
  CREDENTIAL_PRESETS,
  resolveCredentialTypeTag,
  humanizeTypeTag,
  type CredentialPresetId,
} from '@/lib/civic/credential-display';
import { useTranslation } from '@/lib/i18n';

/** Validate the optional expiry input (`YYYY-MM-DD`, must be a future calendar date). */
function parseExpiry(text: string): { iso?: string; valid: boolean; empty: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { valid: true, empty: true };
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) return { valid: false, empty: false };
  const end = new Date(`${trimmed}T23:59:59.999Z`);
  if (Number.isNaN(end.getTime())) return { valid: false, empty: false };
  // Reject overflowed calendar dates (e.g. 2026-02-30 normalizes to March).
  if (end.toISOString().slice(0, 10) !== trimmed) return { valid: false, empty: false };
  if (end.getTime() <= Date.now()) return { valid: false, empty: false };
  return { iso: end.toISOString(), valid: true, empty: false };
}

/**
 * Issue a credential (Fase 4) — the issuer signs a verifiable claim ABOUT the
 * scanned holder with their own on-device key.
 *
 * Reuses the scanned subject's signed card (`useCivicCard`) for their name +
 * avatar, then collects a credential type (a small preset list + a free-form
 * custom label), a free-text claim statement, and an optional expiry. The issue
 * is gated behind the device biometric (it signs a `credential` record on the
 * issuer's chain).
 *
 * NATIVE-ONLY (the credential signs with the on-device key).
 */
export default function IssueCredentialScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { did } = useLocalSearchParams<{ did: string }>();

  const userId = useMemo(() => (did ? userIdFromDid(did) : null), [did]);
  const cardQuery = useCivicCard(userId);
  const card = cardQuery.data?.card;
  const subjectName = card?.name ?? '';
  const displayName = subjectName || t('civic.credentials.issue.unknownPerson');

  const [presetId, setPresetId] = useState<CredentialPresetId>('employment');
  const [customLabel, setCustomLabel] = useState('');
  const [statement, setStatement] = useState('');
  const [expiryText, setExpiryText] = useState('');

  const { state, biometricFailed, errorCode, issue } = useIssueCredential(
    did ?? null,
    t('civic.credentials.issue.biometricReason'),
  );

  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(id)');
  }, [router]);

  const typeTag = useMemo(
    () => resolveCredentialTypeTag(presetId, customLabel),
    [presetId, customLabel],
  );
  const expiry = useMemo(() => parseExpiry(expiryText), [expiryText]);
  const trimmedStatement = statement.trim();

  const busy = state === 'issuing';
  const canSubmit = !busy && typeTag !== null && trimmedStatement.length > 0 && expiry.valid;

  const handleIssue = useCallback(() => {
    if (!typeTag || trimmedStatement.length === 0 || !expiry.valid) return;
    void issue({
      types: [typeTag],
      claims: { statement: trimmedStatement },
      expiresAt: expiry.empty ? undefined : expiry.iso,
    });
  }, [issue, typeTag, trimmedStatement, expiry]);

  const renderBody = () => {
    if (!userId || !did) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.credentials.issue.invalidTitle')}
          description={t('civic.credentials.issue.invalidBody')}
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    if (state === 'done') {
      const issuedTypeLabel = typeTag ? humanizeTypeTag(typeTag) : '';
      return (
        <EmptyState
          illustration={<Icons.credential size="3xl" fill={colors.success} />}
          title={t('civic.credentials.issue.done.title')}
          description={t('civic.credentials.issue.done.body', { type: issuedTypeLabel, name: displayName })}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={handleClose}>{t('common.done')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    if (state === 'error') {
      return (
        <EmptyState
          illustration={<Icons.alert size="3xl" fill={colors.error} />}
          title={t('civic.credentials.issue.error.title')}
          description={t(`civic.credentials.issue.error.${errorCode ?? 'generic'}`)}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={handleClose}>{t('common.close')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    if (cardQuery.isPending && !card) {
      return <LoadingState description={t('civic.credentials.issue.loading')} />;
    }

    return (
      <>
        {/* Subject identity */}
        <View style={styles.identityRow}>
          {card?.avatarUrl ? (
            <Image source={{ uri: card.avatarUrl }} style={styles.avatar} resizeMode="cover" />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder, { backgroundColor: colors.border }]}>
              <Text style={[styles.avatarInitial, { color: colors.textSecondary }]}>
                {displayName.charAt(0)?.toUpperCase() || '?'}
              </Text>
            </View>
          )}
          <View className="flex-1">
            <BloomText style={styles.name} numberOfLines={2}>
              {displayName}
            </BloomText>
            {card?.username && (
              <BloomText style={[styles.username, { color: colors.textSecondary }]} numberOfLines={1}>
                @{card.username}
              </BloomText>
            )}
          </View>
        </View>

        <BloomText style={[styles.intro, { color: colors.text }]}>
          {t('civic.credentials.issue.intro', { name: displayName })}
        </BloomText>

        {/* Credential type */}
        <Section title={t('civic.credentials.issue.typeTitle')} subtitle={t('civic.credentials.issue.typeHint')}>
          <View className="flex-row flex-wrap gap-space-8">
            {CREDENTIAL_PRESETS.map((preset) => {
              const selected = preset.id === presetId;
              return (
                <TouchableOpacity
                  key={preset.id}
                  onPress={() => setPresetId(preset.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={[
                    styles.presetChip,
                    { borderColor: selected ? colors.tint : colors.border },
                    selected && { backgroundColor: colors.primarySubtle },
                  ]}
                >
                  <Text style={[styles.presetText, { color: selected ? colors.tint : colors.text }]}>
                    {t(`civic.credentials.issue.preset.${preset.id}`)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {presetId === 'custom' && (
            <View className="gap-space-8 mt-space-4">
              <BloomText style={[styles.fieldLabel, { color: colors.textSecondary }]}>
                {t('civic.credentials.issue.customLabel')}
              </BloomText>
              <TextInput
                value={customLabel}
                onChangeText={setCustomLabel}
                editable={!busy}
                placeholder={t('civic.credentials.issue.customPlaceholder')}
                placeholderTextColor={colors.textSecondary}
                accessibilityLabel={t('civic.credentials.issue.customLabel')}
                style={[styles.input, { color: colors.text, borderColor: colors.border }]}
              />
            </View>
          )}
        </Section>

        {/* Claim statement */}
        <Section title={t('civic.credentials.issue.statementTitle')} subtitle={t('civic.credentials.issue.statementHint')}>
          <TextInput
            value={statement}
            onChangeText={setStatement}
            editable={!busy}
            multiline
            numberOfLines={4}
            placeholder={t('civic.credentials.issue.statementPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel={t('civic.credentials.issue.statementTitle')}
            style={[styles.input, styles.multiline, { color: colors.text, borderColor: colors.border }]}
          />
        </Section>

        {/* Optional expiry */}
        <Section title={t('civic.credentials.issue.expiryTitle')} subtitle={t('civic.credentials.issue.expiryHint')}>
          <TextInput
            value={expiryText}
            onChangeText={setExpiryText}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            placeholder={t('civic.credentials.issue.expiryPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel={t('civic.credentials.issue.expiryTitle')}
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
          />
          {!expiry.valid && (
            <BloomText style={[styles.fieldError, { color: colors.warning }]}>
              {t('civic.credentials.issue.expiryInvalid')}
            </BloomText>
          )}
        </Section>

        {/* Attribution warning */}
        <Admonition type="info">
          {t('civic.credentials.issue.attribution', { name: displayName })}
        </Admonition>

        {biometricFailed && (
          <BloomText style={[styles.inlineWarn, { color: colors.warning }]}>
            {t('civic.credentials.issue.biometricFailed')}
          </BloomText>
        )}

        <Button appearance="solid" tone="accent" size="lg" icon={Icons.personhood} onPress={handleIssue} loading={busy} disabled={!canSubmit} style={fullWidthControl}>{t('civic.credentials.issue.cta')}</Button>

        {busy && (
          <BloomText style={[styles.muted, styles.centerText, { color: colors.textSecondary }]}>
            {t('civic.credentials.issue.submitting')}
          </BloomText>
        )}
      </>
    );
  };

  return (
    <Screen gap={20}>
      <StackHeader
        title={t('civic.credentials.issue.title')}
        onBack={handleClose}
        backAccessibilityLabel={t('common.back')}
      />
      {renderBody()}
    </Screen>
  );
}

const styles = StyleSheet.create({
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 24,
    fontWeight: '600',
  },
  name: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  username: {
    fontSize: 14,
    marginTop: 2,
  },
  intro: {
    fontSize: 15,
    lineHeight: 21,
  },
  presetChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  presetText: {
    fontSize: 14,
    fontWeight: '600',
  },
  field: {
    gap: 8,
    marginTop: 4,
  },
  fieldLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  fieldError: {
    fontSize: 13,
  },
  inlineWarn: {
    fontSize: 13,
    lineHeight: 18,
  },
  muted: {
    fontSize: 14,
    lineHeight: 20,
  },
  centerText: {
    textAlign: 'center',
  },
});
