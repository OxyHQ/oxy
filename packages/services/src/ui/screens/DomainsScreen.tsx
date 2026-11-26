import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { skip, useAction, useEntity, useList } from '@oxy.so/bloom-data';
import type { DomainVerificationInstructions, VerifiedDomain } from '@oxy.so/contracts';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { TextField, TextFieldHint, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { DOMAIN_NAME_MAX_LENGTH, normalizeDomainName } from '@oxy.so/contracts/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import type { BaseScreenProps } from '../types/navigation';
import { SettingsIcon } from '../components/SettingsIcon';
import { useOxy } from '../context/oxyRuntimeContext';
import {
  Domain,
  domains as verifiedDomains,
  removeDomain,
  requestDomainVerification,
  verifyDomain,
} from '../data/domains';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useApiErrorToast } from '../hooks/useApiErrorToast';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * DomainsScreen — prove that the signed-in identity controls a web domain.
 *
 * Request a verification for a domain, publish either the DNS TXT record or the
 * `.well-known` file the API answers with, then verify. Verified domains are
 * listed and can be removed. Drives `oxy.identity.domains.*`
 * (`/identity/domains`).
 */
const DomainsScreen: React.FC<BaseScreenProps> = () => {
  const themed = useThemedStyles();
  const { t } = useI18n();
  const showApiError = useApiErrorToast();
  useSurfaceHeader({ title: t('domains.title') });
  const bloomTheme = useTheme();
  const { oxyServices, user, isAuthenticated } = useOxy();

  const [domain, setDomain] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState<DomainVerificationInstructions | null>(null);

  const domains = useList(
    verifiedDomains,
    ...(isAuthenticated && user?.id ? [oxyServices] : [skip]),
  );
  const request = useAction(requestDomainVerification);
  const verify = useAction(verifyDomain);
  const remove = useAction(removeDomain);
  const runRemove = remove.run;

  const confirmRemove = useCallback(
    async (item: VerifiedDomain) => {
      const confirmed = await surfaces.confirm({
        title: t('domains.remove.title'),
        description: t('domains.remove.message', { domain: item.domain }),
        confirmLabel: t('domains.remove.confirm'),
        cancelLabel: t('common.cancel') || 'Cancel',
        destructive: true,
      });
      if (!confirmed) return;
      runRemove(oxyServices, item.domain).catch((error: unknown) =>
        showApiError(error, 'domains.errors.remove'),
      );
    },
    [runRemove, oxyServices, showApiError, t],
  );

  const submit = () => {
    if (request.isPending || !domain.trim()) return;
    // The same normalization `POST /identity/domains` applies.
    const name = normalizeDomainName(domain);
    if (name === null) {
      setInvalid(true);
      return;
    }
    request.run(oxyServices, name).then(
      (instructions) => {
        if (!instructions) return;
        setPending(instructions);
        setDomain('');
      },
      (error: unknown) => showApiError(error, 'domains.errors.request'),
    );
  };

  const confirmVerified = (name: string) => {
    verify.run(oxyServices, name).then(
      (result) => {
        if (!result) return;
        if (!result.verified) {
          toast.error(t('domains.errors.notYet'));
          return;
        }
        setPending(null);
        toast.success(t('domains.verified', { domain: result.domain.domain }));
      },
      (error: unknown) => showApiError(error, 'domains.errors.notYet'),
    );
  };

  return (
    <View style={styles.section}>
      {pending ? (
        <GroupedSection title={t('domains.instructions.title', { domain: pending.domain })}>
          <View style={[styles.section2, styles.instructions]}>
            <Text style={themed.mutedText}>{t('domains.instructions.dns')}</Text>
            <Text selectable testID="domains-dns-name">
              {pending.dns.name}
            </Text>
            <Text selectable testID="domains-dns-value">
              {pending.dns.value}
            </Text>
            <Text style={themed.mutedText}>{t('domains.instructions.wellKnown')}</Text>
            <Text selectable testID="domains-wellknown-url">
              {pending.wellKnown.url}
            </Text>
            <Text selectable testID="domains-wellknown-body">
              {pending.wellKnown.body}
            </Text>
            <Button
              appearance="solid"
              tone="action"
              loading={verify.isPending}
              disabled={verify.isPending}
              onPress={() => confirmVerified(pending.domain)}
              testID="domains-verify"
            >
              {t('domains.instructions.verify')}
            </Button>
            <Button
              appearance="plain"
              tone="neutral"
              onPress={() => setPending(null)}
              testID="domains-cancel"
            >
              {t('common.cancel') || 'Cancel'}
            </Button>
          </View>
        </GroupedSection>
      ) : (
        <GroupedSection title={t('domains.add.title')}>
          <View style={[styles.section2, styles.instructions]}>
            <TextFieldLabel>{t('domains.add.label')}</TextFieldLabel>
            <TextField disabled={request.isPending} invalid={invalid}>
              <TextFieldInput
                testID="domains-input"
                label={t('domains.add.label')}
                value={domain}
                onValueChange={(value) => {
                  setDomain(value);
                  setInvalid(false);
                }}
                placeholder="example.com"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                maxLength={DOMAIN_NAME_MAX_LENGTH}
                returnKeyType="go"
                onSubmitEditing={submit}
              />
            </TextField>
            {invalid ? <TextFieldHint invalid>{t('domains.errors.invalid')}</TextFieldHint> : null}
            <Button
              appearance="solid"
              tone="action"
              loading={request.isPending}
              disabled={request.isPending || domain.trim().length === 0}
              onPress={submit}
              testID="domains-request"
            >
              {t('domains.add.action')}
            </Button>
          </View>
        </GroupedSection>
      )}

      <GroupedSection title={t('domains.list.title')}>
        {domains.ids.length === 0 ? (
          <Text style={themed.mutedText2}>{t('domains.list.empty')}</Text>
        ) : (
          domains.ids.map((id) => (
            <DomainRow
              key={id}
              id={id}
              disabled={remove.isPending}
              onRemove={(item) => void confirmRemove(item)}
            />
          ))
        )}
      </GroupedSection>
    </View>
  );
};

interface DomainRowProps {
  id: string;
  disabled: boolean;
  onRemove: (item: VerifiedDomain) => void;
}

/** One verified domain, read from `Domain`. */
const DomainRow: React.FC<DomainRowProps> = ({ id, disabled, onRemove }) => {
  const { t } = useI18n();
  const bloomTheme = useTheme();
  const item = useEntity(Domain, id);
  if (!item) return null;
  return (
    <GroupedSectionItem
      icon={<SettingsIcon name="web" color={bloomTheme.colors.success} />}
      title={item.domain}
      description={
        item.method === 'dns-txt' ? t('domains.method.dns') : t('domains.method.wellKnown')
      }
      onPress={() => onRemove(item)}
      disabled={disabled}
      destructive
      showChevron={false}
    />
  );
};

// Layout-only: the vertical rhythm between the stacked instruction lines.
const styles = StyleSheet.create({
  instructions: {
    gap: 8,
  },

  section: { paddingHorizontal: 20, paddingBottom: 24 },
  section2: { paddingHorizontal: 16, paddingVertical: 12 },
});

export default React.memo(DomainsScreen);

const useThemedStyles = createTokenStyles((t) => ({
  mutedText: { color: t.mutedForeground },
  mutedText2: { paddingHorizontal: 16, paddingVertical: 12, color: t.mutedForeground },
}));
