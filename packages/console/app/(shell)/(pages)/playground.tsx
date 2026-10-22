import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Textarea } from '@oxy.so/bloom/textarea';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { ContentScreen } from '@/components/content/ContentScreen';
import { Notice } from '@/components/content/Notice';
import { OptionSelect } from '@/components/content/OptionSelect';
import { RichText } from '@/components/content/RichText';
import { Section } from '@/components/content/Section';
import type { Href } from 'expo-router';
import config from '@/lib/config';
import { TextLink } from '@/components/content/TextLink';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { PlaygroundOutput } from '@/components/playground/PlaygroundOutput';
import { PlaygroundRunReceipt } from '@/components/playground/playground-receipt';
import { accountLabel, useAccount } from '@/hooks/use-account';
import {
  useApplicationCredentials,
  useApplications,
  useCallerAccess,
} from '@/hooks/use-applications';
import { useModelCatalogue } from '@/hooks/use-models';
import { usePlaygroundReceipt, usePlaygroundRun } from '@/hooks/use-playground';
import { useTranslation } from '@/lib/i18n';
import { usePlaygroundKey } from '@/lib/playground-key';

/**
 * The playground: one real request to the public inference edge.
 *
 * ## Where the credential comes from, and the option that was rejected
 *
 * The edge authenticates an `oxy_sk_…` machine credential or a verified service
 * token, and NOTHING else (ADR 0010). A Console user's session bearer is not a
 * principal of that lane, and Console cannot recover a credential secret it once
 * displayed: the API returns it exactly once and stores only its hash. So the key
 * has to be supplied.
 *
 *  - **A. The user pastes one.** Implemented. It lives in memory for this browser
 *    session and never touches storage, a cache, a query key or a URL.
 *  - **B. Offered at creation**, when a credential is created or rotated. The SAME
 *    code path as A (`lib/playground-key.ts`), so there are not two ways for a key
 *    to reach this screen.
 *  - **C. A Console-only server endpoint** that takes the session bearer and invokes
 *    the edge server-side. **REJECTED:** it re-introduces an ambient-session lane
 *    onto the inference path, which is exactly what ADR 0010 pushed out. Not to be
 *    built without a new ADR that overturns 0010.
 *
 * The environment is not a picker: it is a PROPERTY of the credential, so the
 * screen shows it and does not offer it. Two controls that can disagree about the
 * environment is a bug with a UI.
 */
export default function PlaygroundScreen() {
  const { t } = useTranslation();
  const { currentAccount } = useAccount();
  const { data: applications = [], isLoading: isLoadingApps } = useApplications();
  const { data: catalogue = [] } = useModelCatalogue();

  // The key is the store's, so the "try this key in the playground" hand-off from a
  // freshly created credential and a paste here are one path.
  const apiKey = usePlaygroundKey((state) => state.apiKey);
  const setApiKey = usePlaygroundKey((state) => state.setApiKey);

  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState('');

  const run = usePlaygroundRun();
  const receipt = usePlaygroundReceipt();

  // Every selection is DERIVED against the loaded data rather than synced into state
  // by an effect: a credential id from the previous application is simply not found
  // in the new list, so the fallback picks the new application's first key.
  const application =
    applications.find((candidate) => candidate._id === applicationId) ?? applications.at(0);
  const access = useCallerAccess(application);
  const canReadCredentials = access.can('credentials:read');

  const { data: credentials = [] } = useApplicationCredentials(
    application?._id ?? '',
    application !== undefined && canReadCredentials,
  );

  // Only a `machine` credential can authenticate the edge, and only an active one
  // resolves; offering a revoked key would produce a refusal the user cannot act on.
  const machineCredentials = credentials.filter(
    (candidate) => candidate.type === 'machine' && candidate.status === 'active',
  );
  const credential =
    machineCredentials.find((candidate) => candidate._id === credentialId) ??
    machineCredentials.at(0);

  const selectedModel =
    catalogue.find((candidate) => candidate.modelId === model)?.modelId ?? catalogue.at(0)?.modelId;

  // `tokenPrefix` is the PUBLIC half of a machine token (`oxy_sk_<16 hex>`) and the
  // full bearer is `<prefix>_<64 hex>`, so this is an exact, offline check. Nothing is
  // validated about the secret half: only the server can do that.
  const keyMatchesCredential =
    apiKey.trim() === '' || credential?.tokenPrefix === undefined
      ? undefined
      : apiKey.trim().startsWith(`${credential.tokenPrefix}_`);

  const canRun =
    apiKey.trim() !== '' && selectedModel !== undefined && input.trim() !== '' && !run.isPending;

  const result = run.data;
  const completed = result?.status === 'completed' ? result.run : undefined;

  const handleRun = () => {
    if (selectedModel === undefined) return;
    // A new run invalidates the previous receipt: it belonged to another request id.
    receipt.reset();
    run.mutate({ apiKey: apiKey.trim(), model: selectedModel, input: input.trim() });
  };

  return (
    <ContentScreen title={t('playgroundPage.title')} subtitle={t('playgroundPage.subtitle')}>
      {/* Kept ahead of every control: a run costs a real request against a real
          credential and today it cannot succeed; saying so after the click wastes it. */}
      <InferenceAvailabilityNotice />

      <Section
        title={t('playgroundPage.request.title')}
        description={t('playgroundPage.request.description')}
        className="gap-4"
      >
        {/* Read-only on purpose: account selection is global to this Console and every
            account-derived permission follows it; a second picker could disagree. */}
        <View className="gap-1.5">
          <Text className="text-xs text-muted-foreground">
            {t('playgroundPage.request.account')}
          </Text>
          <Text className="text-sm text-foreground">
            {currentAccount === null
              ? t('playgroundPage.request.noAccount')
              : accountLabel(currentAccount)}
          </Text>
        </View>

        <View className="gap-1.5">
          {isLoadingApps ? (
            <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
          ) : applications.length === 0 ? (
            <RichText>{t('playgroundPage.request.noApplications')}</RichText>
          ) : (
            <OptionSelect
              label={t('playgroundPage.request.application')}
              value={application?._id ?? ''}
              options={applications.map((candidate) => ({
                value: candidate._id,
                label: candidate.name,
              }))}
              onChange={(value) => {
                setApplicationId(value);
                // Cleared rather than remapped: the new application's credentials have
                // not loaded yet, so there is no id here that could be correct.
                setCredentialId(null);
              }}
            />
          )}
        </View>

        <View className="gap-1.5">
          {!canReadCredentials ? (
            <RichText>{t('playgroundPage.request.noCredentialAccess')}</RichText>
          ) : machineCredentials.length === 0 ? (
            <RichText>
              {application === undefined
                ? t('playgroundPage.request.noKeyShort')
                : t('playgroundPage.request.noKey', { id: application._id })}
            </RichText>
          ) : (
            <>
              <OptionSelect
                label={t('playgroundPage.request.credential')}
                value={credential?._id ?? ''}
                options={machineCredentials.map((candidate) => ({
                  value: candidate._id,
                  label: `${candidate.name} · ${candidate.environment}`,
                }))}
                onChange={setCredentialId}
              />
              {credential !== undefined && (
                <View className="flex-row flex-wrap items-center gap-2 pt-1">
                  <Badge size="label-small" variant="subtle" content={credential.environment} />
                  {credential.tokenPrefix !== undefined && (
                    <Text className="font-mono text-xs text-muted-foreground">
                      {credential.tokenPrefix}
                    </Text>
                  )}
                </View>
              )}
            </>
          )}
        </View>

        {/* The secret itself. Masked and `autoComplete="off"`: this is a bearer token,
            and a password manager offering to save it would put it where it must not go. */}
        <View className="gap-1.5">
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
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
          <Text className="text-xs text-muted-foreground">
            {t('playgroundPage.request.apiKeyHint')}
          </Text>
          {keyMatchesCredential === false && (
            <Text className="text-xs text-warning">{t('playgroundPage.request.keyMismatch')}</Text>
          )}
        </View>

        <View className="gap-1.5">
          {catalogue.length === 0 ? (
            <RichText>{t('playgroundPage.request.emptyCatalogue')}</RichText>
          ) : (
            <OptionSelect
              label={t('playgroundPage.request.model')}
              value={selectedModel ?? ''}
              options={catalogue.map((entry) => ({
                value: entry.modelId,
                label: `${entry.displayName} · ${entry.modelId}`,
              }))}
              onChange={setModel}
            />
          )}
        </View>

        <Textarea
          label={t('playgroundPage.request.input')}
          value={input}
          onChangeText={setInput}
          rows={5}
          placeholder={t('playgroundPage.request.inputPlaceholder')}
        />

        <View className="items-start">
          <Button onPress={handleRun} disabled={!canRun} loading={run.isPending}>
            {run.isPending ? t('playgroundPage.request.running') : t('playgroundPage.request.run')}
          </Button>
        </View>
      </Section>

      {/* A transport failure (no network, DNS, a blocked request): there is no server
          answer and therefore no request id to report, which is why it is separate
          from a refusal. */}
      {run.isError && (
        <Notice
          tone="danger"
          title={t('playgroundPage.error.title')}
          paragraphs={[
            run.error instanceof Error ? run.error.message : t('playgroundPage.error.generic'),
          ]}
        />
      )}

      {/* A refusal from the edge is a real answer and is rendered as one: the closed
          error code, whether an identical retry could ever succeed, and the request id,
          without which the user has nothing to quote when reporting it. */}
      {result?.status === 'refused' && (
        <View className="gap-2 rounded-lg border border-border p-4">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-sm font-semibold text-foreground">
              {t('playgroundPage.refused.title')}
            </Text>
            <Badge size="label-small" variant="outlined" content={result.error.code} />
            <Badge
              size="label-small"
              variant="subtle"
              content={
                result.error.retryable
                  ? t('playgroundPage.refused.retryable')
                  : t('playgroundPage.refused.notRetryable')
              }
            />
          </View>
          <Text className="text-sm text-muted-foreground">{result.error.message}</Text>
          <Text selectable className="font-mono text-xs text-muted-foreground">
            {t('playgroundPage.refused.requestId', { id: result.error.requestId })}
          </Text>
        </View>
      )}

      {completed !== undefined && (
        <>
          <Section title={t('playgroundPage.output.title')}>
            <View className="gap-3 rounded-lg border border-border p-4">
              {completed.output.map((message, index) => (
                <PlaygroundOutput key={index} message={message} />
              ))}
            </View>
          </Section>

          <PlaygroundRunReceipt
            run={completed}
            receipt={receipt.data}
            isFetchingReceipt={receipt.isPending}
            onFetchReceipt={() =>
              receipt.mutate({ apiKey: apiKey.trim(), requestId: completed.requestId })
            }
            receiptError={receipt.error instanceof Error ? receipt.error.message : undefined}
          />
        </>
      )}

      <TextLink href={config.docsUrl as Href}>{t('playgroundPage.readReference')}</TextLink>
    </ContentScreen>
  );
}
