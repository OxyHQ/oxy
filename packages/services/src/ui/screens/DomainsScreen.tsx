import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DomainVerificationInstructions, VerifiedDomain } from '@oxy.so/contracts';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import type { BaseScreenProps } from '../types/navigation';
import { SettingsIcon } from '../components/SettingsIcon';
import { useOxy } from '../context/OxyContext';
import { queryKeys } from '../hooks/queries/queryKeys';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';

const errorMessage = (error: unknown, fallback: string): string =>
    (error instanceof Error && error.message) || fallback;

/**
 * DomainsScreen — prove that the signed-in identity controls a web domain.
 *
 * Request a verification for a domain, publish either the DNS TXT record or the
 * `.well-known` file the API answers with, then verify. Verified domains are
 * listed and can be removed. Drives `oxy.identity.domains.*`
 * (`/identity/domains`).
 */
const DomainsScreen: React.FC<BaseScreenProps> = () => {
    const { t } = useI18n();
    useSurfaceHeader({ title: t('domains.title') });
    const bloomTheme = useTheme();
    const queryClient = useQueryClient();
    const { oxyServices, user, isAuthenticated } = useOxy();

    const [domain, setDomain] = useState('');
    const [pending, setPending] = useState<DomainVerificationInstructions | null>(null);

    const listKey = queryKeys.domains.list(user?.id);
    const domains = useQuery({
        queryKey: listKey,
        enabled: isAuthenticated && Boolean(user?.id),
        queryFn: () => oxyServices.identity.domains.list(),
    });

    const request = useMutation({
        mutationFn: (name: string) => oxyServices.identity.domains.requestVerification(name),
        onSuccess: (instructions) => {
            setPending(instructions);
            setDomain('');
        },
        onError: (error) => toast.error(errorMessage(error, t('domains.errors.request'))),
    });

    const verify = useMutation({
        mutationFn: (name: string) => oxyServices.identity.domains.verify(name),
        onSuccess: (result) => {
            if (!result.verified) {
                toast.error(t('domains.errors.notYet'));
                return;
            }
            setPending(null);
            toast.success(t('domains.verified', { domain: result.domain.domain }));
            void queryClient.invalidateQueries({ queryKey: listKey });
        },
        onError: (error) => toast.error(errorMessage(error, t('domains.errors.notYet'))),
    });

    const remove = useMutation({
        mutationFn: (name: string) => oxyServices.identity.domains.remove(name),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
        onError: (error) => toast.error(errorMessage(error, t('domains.errors.remove'))),
    });

    const confirmRemove = useCallback(
        async (item: VerifiedDomain) => {
            const confirmed = await surfaces.confirm({
                title: t('domains.remove.title'),
                description: t('domains.remove.message', { domain: item.domain }),
                confirmLabel: t('domains.remove.confirm'),
                cancelLabel: t('common.cancel') || 'Cancel',
                destructive: true,
            });
            if (confirmed) remove.mutate(item.domain);
        },
        [remove, t],
    );

    const submit = () => {
        const name = domain.trim().toLowerCase();
        if (name && !request.isPending) request.mutate(name);
    };

    if (domains.isPending && isAuthenticated) {
        return <Loading size="large" color={bloomTheme.colors.primary} />;
    }

    return (
        <View className="px-screen-margin pb-space-24">
            {pending ? (
                <SettingsListGroup title={t('domains.instructions.title', { domain: pending.domain })}>
                    <View className="px-space-16 py-space-12" style={styles.instructions}>
                        <Text className="text-text-secondary">{t('domains.instructions.dns')}</Text>
                        <Text selectable testID="domains-dns-name">{pending.dns.name}</Text>
                        <Text selectable testID="domains-dns-value">{pending.dns.value}</Text>
                        <Text className="text-text-secondary">{t('domains.instructions.wellKnown')}</Text>
                        <Text selectable testID="domains-wellknown-url">{pending.wellKnown.url}</Text>
                        <Text selectable testID="domains-wellknown-body">{pending.wellKnown.body}</Text>
                        <Button
                            appearance="solid"
                            tone="action"
                            loading={verify.isPending}
                            disabled={verify.isPending}
                            onPress={() => verify.mutate(pending.domain)}
                            testID="domains-verify"
                        >
                            {t('domains.instructions.verify')}
                        </Button>
                        <Button appearance="plain" tone="neutral" onPress={() => setPending(null)} testID="domains-cancel">
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                    </View>
                </SettingsListGroup>
            ) : (
                <SettingsListGroup title={t('domains.add.title')}>
                    <View className="px-space-16 py-space-12" style={styles.instructions}>
                        <TextFieldLabel>{t('domains.add.label')}</TextFieldLabel>
                        <TextField disabled={request.isPending}>
                            <TextFieldInput
                                testID="domains-input"
                                label={t('domains.add.label')}
                                value={domain}
                                onValueChange={setDomain}
                                placeholder="example.com"
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                returnKeyType="go"
                                onSubmitEditing={submit}
                            />
                        </TextField>
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
                </SettingsListGroup>
            )}

            <SettingsListGroup title={t('domains.list.title')}>
                {(domains.data ?? []).length === 0 ? (
                    <Text className="text-text-secondary px-space-16 py-space-12">{t('domains.list.empty')}</Text>
                ) : (
                    (domains.data ?? []).map((item) => (
                        <SettingsListItem
                            key={item.domain}
                            icon={<SettingsIcon name="web" color={bloomTheme.colors.success} />}
                            title={item.domain}
                            description={item.method === 'dns-txt' ? t('domains.method.dns') : t('domains.method.wellKnown')}
                            onPress={() => void confirmRemove(item)}
                            disabled={remove.isPending}
                            destructive
                            showChevron={false}
                        />
                    ))
                )}
            </SettingsListGroup>
        </View>
    );
};

// Layout-only: the vertical rhythm between the stacked instruction lines.
const styles = StyleSheet.create({
    instructions: {
        gap: 8,
    },
});

export default React.memo(DomainsScreen);
