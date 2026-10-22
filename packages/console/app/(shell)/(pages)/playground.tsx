import { Admonition } from '@oxy.so/bloom/admonition';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { Item } from '@oxy.so/bloom/item';
import { Markdown } from '@oxy.so/bloom/markdown';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextFieldHint, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

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
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { usePlaygroundKey } from '@/lib/playground-key';

interface ParamOption {
  value: string;
  label: string;
}

/** One request parameter chosen from a list the screen has already loaded. */
function ParamSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<ParamOption>;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger label={label}>
          <SelectValue>{() => options.find((option) => option.value === value)?.label}</SelectValue>
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={options}
          valueExtractor={(option) => option.value}
          renderItem={(option) => (
            <SelectItem value={option.value} label={option.label}>
              <SelectItemIndicator />
              <SelectItemText>{option.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
    </Field>
  );
}

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
  const router = useRouter();
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

  const openLink = (url: string) => router.navigate(url as never);

  const handleRun = () => {
    if (selectedModel === undefined) return;
    // A new run invalidates the previous receipt: it belonged to another request id.
    receipt.reset();
    run.mutate({ apiKey: apiKey.trim(), model: selectedModel, input: input.trim() });
  };

  return (
    <Screen
      className="flex-1 bg-background"
      header={
        <PageHeader
          title={t('playgroundPage.title')}
          subtitle={t('playgroundPage.subtitle')}
          leading={<AppShellMenuButton />}
          presentation="bar"
          sticky={false}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-6">
        <View className="w-full max-w-4xl gap-6">
          {/* Kept ahead of every control: a run costs a real request against a real
              credential and today it cannot succeed; saying so after the click wastes it. */}
          <InferenceAvailabilityNotice />

          <Card>
            <CardHeader>
              <CardTitle>{t('playgroundPage.request.title')}</CardTitle>
              <CardDescription>{t('playgroundPage.request.description')}</CardDescription>
            </CardHeader>
            <CardBody>
              <View className="gap-4">
                {/* Read-only on purpose: account selection is global to this Console and
                    every account-derived permission follows it; a second picker could
                    disagree. */}
                <Item
                  density="compact"
                  title={t('playgroundPage.request.account')}
                  subtitle={
                    currentAccount === null
                      ? t('playgroundPage.request.noAccount')
                      : accountLabel(currentAccount)
                  }
                />

                {isLoadingApps ? (
                  <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
                ) : applications.length === 0 ? (
                  <Markdown size="sm" onLinkPress={openLink}>
                    {t('playgroundPage.request.noApplications')}
                  </Markdown>
                ) : (
                  <ParamSelect
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

                {!canReadCredentials ? (
                  <Markdown size="sm" onLinkPress={openLink}>
                    {t('playgroundPage.request.noCredentialAccess')}
                  </Markdown>
                ) : machineCredentials.length === 0 ? (
                  <Markdown size="sm" onLinkPress={openLink}>
                    {application === undefined
                      ? t('playgroundPage.request.noKeyShort')
                      : t('playgroundPage.request.noKey', { id: application._id })}
                  </Markdown>
                ) : (
                  <View className="gap-2">
                    <ParamSelect
                      label={t('playgroundPage.request.credential')}
                      value={credential?._id ?? ''}
                      options={machineCredentials.map((candidate) => ({
                        value: candidate._id,
                        label: `${candidate.name} · ${candidate.environment}`,
                      }))}
                      onChange={setCredentialId}
                    />
                    {credential !== undefined && (
                      <View className="flex-row flex-wrap items-center gap-2">
                        <Badge
                          size="label-small"
                          variant="subtle"
                          content={credential.environment}
                        />
                        {credential.tokenPrefix !== undefined && (
                          <Text className="font-mono text-xs text-muted-foreground">
                            {credential.tokenPrefix}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                )}

                {/* The secret itself. Masked and `autoComplete="off"`: this is a bearer token,
                    and a password manager offering to save it would put it where it must not
                    go. */}
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
                <TextFieldHint>{t('playgroundPage.request.apiKeyHint')}</TextFieldHint>
                {keyMatchesCredential === false && (
                  <Admonition type="warning">{t('playgroundPage.request.keyMismatch')}</Admonition>
                )}

                {catalogue.length === 0 ? (
                  <Markdown size="sm" onLinkPress={openLink}>
                    {t('playgroundPage.request.emptyCatalogue')}
                  </Markdown>
                ) : (
                  <ParamSelect
                    label={t('playgroundPage.request.model')}
                    value={selectedModel ?? ''}
                    options={catalogue.map((entry) => ({
                      value: entry.modelId,
                      label: `${entry.displayName} · ${entry.modelId}`,
                    }))}
                    onChange={setModel}
                  />
                )}

                <Textarea
                  label={t('playgroundPage.request.input')}
                  value={input}
                  onChangeText={setInput}
                  rows={5}
                  placeholder={t('playgroundPage.request.inputPlaceholder')}
                />

                <View className="items-start">
                  <Button onPress={handleRun} disabled={!canRun} loading={run.isPending}>
                    {run.isPending
                      ? t('playgroundPage.request.running')
                      : t('playgroundPage.request.run')}
                  </Button>
                </View>
              </View>
            </CardBody>
          </Card>

          {/* A transport failure (no network, DNS, a blocked request): there is no server
              answer and therefore no request id to report, which is why it is separate
              from a refusal. */}
          {run.isError && (
            <Admonition type="error">
              {`${t('playgroundPage.error.title')} ${
                run.error instanceof Error ? run.error.message : t('playgroundPage.error.generic')
              }`}
            </Admonition>
          )}

          {/* A refusal from the edge is a real answer and is rendered as one: the closed
              error code, whether an identical retry could ever succeed, and the request id,
              without which the user has nothing to quote when reporting it. */}
          {result?.status === 'refused' && (
            <Card>
              <CardHeader>
                <CardTitle>{t('playgroundPage.refused.title')}</CardTitle>
                <CardDescription>{result.error.message}</CardDescription>
              </CardHeader>
              <CardBody>
                <View className="gap-2">
                  <View className="flex-row flex-wrap items-center gap-2">
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
                  <Text selectable className="font-mono text-xs text-muted-foreground">
                    {t('playgroundPage.refused.requestId', { id: result.error.requestId })}
                  </Text>
                </View>
              </CardBody>
            </Card>
          )}

          {completed !== undefined && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>{t('playgroundPage.output.title')}</CardTitle>
                </CardHeader>
                <CardBody>
                  <View className="gap-3">
                    {completed.output.map((message, index) => (
                      <PlaygroundOutput key={index} message={message} />
                    ))}
                  </View>
                </CardBody>
              </Card>

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

          <View className="items-start">
            <Button
              appearance="plain"
              tone="accent"
              size="sm"
              href={config.docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('playgroundPage.readReference')}
            </Button>
          </View>
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
