import { Admonition } from '@oxy.so/bloom/admonition';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { ComposerPanel, type ModelPickerProvider } from '@oxy.so/bloom/composer-panel';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { CodeBlock } from '@oxy.so/bloom/code';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { PlaygroundConnection } from '@/components/playground/PlaygroundConnection';
import { PlaygroundOutput } from '@/components/playground/PlaygroundOutput';
import {
  type PlaygroundParams,
  PlaygroundParameters,
} from '@/components/playground/PlaygroundParameters';
import { PlaygroundReceipt } from '@/components/playground/PlaygroundReceipt';
import { useModelCatalogue } from '@/hooks/use-models';
import { usePlaygroundReceipt, usePlaygroundRun } from '@/hooks/use-playground';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { usePlaygroundKey } from '@/lib/playground-key';

/**
 * The playground: one real request to the public inference edge.
 *
 * The credential is an `oxy_sk_` key pasted into `PlaygroundConnection` and read here
 * from its in-memory store; it goes into one Authorization header and is never the
 * session bearer, a query key or a URL (ADR 0010). A Console-only server endpoint that
 * took the session bearer instead was rejected: it would put an ambient-session lane
 * back on the inference path.
 */
export default function PlaygroundScreen() {
  const { t } = useTranslation();
  const catalogue = useModelCatalogue();
  const apiKey = usePlaygroundKey((state) => state.apiKey).trim();
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [params, setParams] = useState<PlaygroundParams>({});
  const run = usePlaygroundRun();
  const receipt = usePlaygroundReceipt();

  // The composer's picker lists models by publisher.
  const providers = useMemo<Array<ModelPickerProvider>>(() => {
    const grouped = new Map<string, ModelPickerProvider>();
    for (const entry of catalogue.data ?? []) {
      const provider = grouped.get(entry.publisher.slug) ?? {
        id: entry.publisher.slug,
        name: entry.publisher.displayName,
        models: [],
      };
      grouped.set(entry.publisher.slug, {
        ...provider,
        models: [...provider.models, { id: entry.modelId, name: entry.displayName }],
      });
    }
    return [...grouped.values()];
  }, [catalogue.data]);

  const selectedModel =
    providers.flatMap((provider) => provider.models).find((entry) => entry.id === model)?.id ??
    providers.at(0)?.models.at(0)?.id;

  const result = run.data;
  const completed = result?.status === 'completed' ? result.run : undefined;

  const handleRun = (prompt: string) => {
    if (selectedModel === undefined || apiKey === '' || prompt.trim() === '') return;
    // A new run invalidates the previous receipt: it belonged to another request id.
    receipt.reset();
    run.mutate({ apiKey, model: selectedModel, input: prompt.trim(), ...params });
  };

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={t('playgroundPage.title')}
          subtitle={t('playgroundPage.subtitle')}
          leading={<AppShellMenuButton />}
          actions={
            <Button
              appearance="outline"
              size="sm"
              href={config.docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('playgroundPage.readReference')}
            </Button>
          }
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="gap-6 p-4 md:p-6">
        {/* Ahead of every control: a run is a real request against a real credential. */}
        <InferenceAvailabilityNotice />

        <View className="flex-row flex-wrap gap-6">
          <View className="min-w-72 flex-1 basis-96">
            <PlaygroundConnection />
          </View>
          <View className="min-w-72 flex-1 basis-72">
            <PlaygroundParameters params={params} onChange={setParams} />
          </View>
        </View>

        {catalogue.isSuccess && providers.length === 0 && (
          <Admonition type="info">{t('playgroundPage.request.emptyCatalogue')}</Admonition>
        )}
        <ComposerPanel
          value={input}
          onValueChange={setInput}
          onSubmit={handleRun}
          busy={run.isPending}
          disabled={selectedModel === undefined || apiKey === ''}
          placeholder={t('playgroundPage.request.inputPlaceholder')}
          providers={providers.length > 0 ? providers : undefined}
          model={selectedModel}
          onModelChange={setModel}
          effortLevels={[]}
          permissions={[]}
          addMenu={[]}
        />

        {/* A transport failure has no server answer and so no request id to report; that
            is why it is not rendered as a refusal. */}
        {run.isError && (
          <Admonition type="error">
            {`${t('playgroundPage.error.title')} ${t('playgroundPage.error.generic')}`}
          </Admonition>
        )}

        {/* A refusal is a real answer: the closed error code, whether an identical retry
            could ever succeed, and the request id, which is all a report needs. */}
        {result?.status === 'refused' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('playgroundPage.refused.title')}</CardTitle>
              <CardDescription>{result.error.message}</CardDescription>
            </CardHeader>
            <CardBody>
              <View className="gap-3">
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
                <CodeBlock
                  code={result.error.requestId}
                  filename={t('playgroundPage.receipt.requestId')}
                  lineNumbers={false}
                  wrap
                />
              </View>
            </CardBody>
          </Card>
        )}

        {completed !== undefined && (
          <>
            <PlaygroundOutput output={completed.output} />
            <PlaygroundReceipt
              run={completed}
              receipt={receipt.data}
              isFetchingReceipt={receipt.isPending}
              receiptFailed={receipt.isError}
              onFetchReceipt={() => receipt.mutate({ apiKey, requestId: completed.requestId })}
            />
          </>
        )}
      </ScreenScrollView>
    </Screen>
  );
}
