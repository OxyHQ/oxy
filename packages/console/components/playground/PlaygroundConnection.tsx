import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { Field } from '@oxy.so/bloom/field';
import { Item } from '@oxy.so/bloom/item';
import { Markdown } from '@oxy.so/bloom/markdown';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextFieldHint, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { accountLabel, useAccount } from '@/hooks/use-account';
import {
  useApplicationCredentials,
  useApplications,
  useCallerAccess,
} from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { usePlaygroundKey } from '@/lib/playground-key';

/**
 * Which credential the playground calls with.
 *
 * The edge authenticates an `oxy_sk_` machine key and nothing else (ADR 0010), and
 * Console cannot recover a secret it showed once, so the key is pasted (or handed over
 * from a freshly created credential through `usePlaygroundKey`). It is held in memory
 * only, is never the session bearer, and the environment is read off the credential,
 * never offered as a second control that could disagree with it.
 */
export function PlaygroundConnection() {
  const { t } = useTranslation();
  const router = useRouter();
  const { currentAccount } = useAccount();
  const applications = useApplications();
  const apiKey = usePlaygroundKey((state) => state.apiKey);
  const setApiKey = usePlaygroundKey((state) => state.setApiKey);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);

  // Selections are derived against the loaded data, not synced by an effect: a
  // credential id from the previous application is simply not found in the new list.
  const list = applications.data ?? [];
  const application = list.find((candidate) => candidate._id === applicationId) ?? list.at(0);
  const canReadCredentials = useCallerAccess(application).can('credentials:read');
  const credentials = useApplicationCredentials(
    application?._id ?? '',
    application !== undefined && canReadCredentials,
  );

  // Only an active `machine` credential can authenticate the edge.
  const machineCredentials = (credentials.data ?? []).filter(
    (candidate) => candidate.type === 'machine' && candidate.status === 'active',
  );
  const credential =
    machineCredentials.find((candidate) => candidate._id === credentialId) ??
    machineCredentials.at(0);

  // `tokenPrefix` is the public half of a machine token and the bearer is
  // `<prefix>_<64 hex>`, so this is an exact offline check; the secret half is
  // only ever validated by the server.
  const trimmed = apiKey.trim();
  const keyMismatch =
    trimmed !== '' &&
    credential?.tokenPrefix !== undefined &&
    !trimmed.startsWith(`${credential.tokenPrefix}_`);

  const openLink = (url: string) => router.navigate(url as never);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('playgroundPage.request.title')}</CardTitle>
        <CardDescription>{t('playgroundPage.request.description')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-4">
          <Item
            density="compact"
            title={t('playgroundPage.request.account')}
            subtitle={
              currentAccount === null
                ? t('playgroundPage.request.noAccount')
                : accountLabel(currentAccount)
            }
          />

          {applications.isLoading ? (
            <FormSkeleton count={1} />
          ) : list.length === 0 ? (
            <Markdown size="sm" onLinkPress={openLink}>
              {t('playgroundPage.request.noApplications')}
            </Markdown>
          ) : (
            <Field label={t('playgroundPage.request.application')}>
              <Select
                value={application?._id}
                onValueChange={(value) => {
                  setApplicationId(value);
                  // Cleared, not remapped: the new application's credentials have not
                  // loaded, so there is no id here that could be right.
                  setCredentialId(null);
                }}
              >
                <SelectTrigger label={t('playgroundPage.request.application')}>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent
                  label={t('playgroundPage.request.application')}
                  items={list.map((candidate) => ({ value: candidate._id, label: candidate.name }))}
                  renderItem={(item) => (
                    <SelectItem value={item.value} label={item.label}>
                      <SelectItemText>{item.label}</SelectItemText>
                    </SelectItem>
                  )}
                />
              </Select>
            </Field>
          )}

          {!canReadCredentials ? (
            <Markdown size="sm">{t('playgroundPage.request.noCredentialAccess')}</Markdown>
          ) : machineCredentials.length === 0 ? (
            !applications.isLoading &&
            !credentials.isLoading &&
            application !== undefined && (
              <Markdown size="sm" onLinkPress={openLink}>
                {t('playgroundPage.request.noKey', { id: application._id })}
              </Markdown>
            )
          ) : (
            <Field label={t('playgroundPage.request.credential')}>
              <Select value={credential?._id} onValueChange={setCredentialId}>
                <SelectTrigger label={t('playgroundPage.request.credential')}>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent
                  label={t('playgroundPage.request.credential')}
                  items={machineCredentials.map((candidate) => ({
                    value: candidate._id,
                    label: `${candidate.name} · ${candidate.environment}`,
                  }))}
                  renderItem={(item) => (
                    <SelectItem value={item.value} label={item.label}>
                      <SelectItemText>{item.label}</SelectItemText>
                    </SelectItem>
                  )}
                />
              </Select>
              {credential !== undefined && (
                <View className="mt-2 flex-row flex-wrap items-center gap-2">
                  <Chip size="sm">{credential.environment}</Chip>
                  {credential.tokenPrefix !== undefined && (
                    <Chip size="sm" hue="soft">
                      {credential.tokenPrefix}
                    </Chip>
                  )}
                </View>
              )}
            </Field>
          )}

          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              {/* A bearer token: masked, never autofilled, never offered to a password manager. */}
              <TextFieldInput
                label={t('playgroundPage.request.apiKey')}
                value={apiKey}
                onChangeText={setApiKey}
                placeholder="oxy_sk_…"
                secureTextEntry
                revealable
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            {apiKey !== '' && (
              <Button appearance="outline" onPress={() => setApiKey('')}>
                {t('playgroundPage.request.forget')}
              </Button>
            )}
          </View>
          <TextFieldHint>{t('playgroundPage.request.apiKeyHint')}</TextFieldHint>
          {keyMismatch && (
            <Admonition type="warning">{t('playgroundPage.request.keyMismatch')}</Admonition>
          )}
        </View>
      </CardBody>
    </Card>
  );
}
