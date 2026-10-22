import { Admonition } from '@oxy.so/bloom/admonition';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Item } from '@oxy.so/bloom/item';
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
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Job, SearchMode } from '@clarity.surf/sdk';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { useClarityClient } from '@/hooks/use-clarity';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';

export type ClaritySection =
  | 'overview'
  | 'search'
  | 'news'
  | 'indexing'
  | 'sites'
  | 'jobs'
  | 'usage';

export const CLARITY_SECTIONS: ReadonlyArray<ClaritySection> = [
  'overview',
  'search',
  'news',
  'indexing',
  'sites',
  'jobs',
  'usage',
];

const SEARCH_MODES: ReadonlyArray<SearchMode> = ['hybrid', 'lexical', 'semantic'];

function sectionHref(section: ClaritySection): Href {
  return section === 'overview' ? '/clarity' : (`/clarity/${section}` as Href);
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <Admonition type="error">
      {`${t('clarityPage.error.title')} ${
        error instanceof Error ? error.message : t('clarityPage.error.unexpected')
      }`}
    </Admonition>
  );
}

export function ClarityPage({ section }: { section: ClaritySection }) {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <Screen
      className="flex-1 bg-background"
      header={
        <PageHeader
          title={t('clarityPage.title')}
          subtitle={t('clarityPage.subtitle')}
          leading={<AppShellMenuButton />}
          actions={<Badge size="label-medium" variant="subtle" content={t('clarityPage.beta')} />}
          presentation="bar"
          sticky={false}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-6">
        <View className="w-full max-w-6xl gap-6">
          <Tabs
            value={section}
            onValueChange={(value) => router.navigate(sectionHref(value as ClaritySection))}
            label={t('clarityPage.sectionsLabel')}
          >
            {CLARITY_SECTIONS.map((item) => (
              <TabsTrigger key={item} value={item} label={t(`clarityPage.sections.${item}`)} />
            ))}
          </Tabs>

          {section === 'overview' && <Overview />}
          {section === 'search' && <Search />}
          {section === 'news' && <News />}
          {section === 'indexing' && <Indexing />}
          {section === 'sites' && <Sites />}
          {section === 'jobs' && <Jobs />}
          {section === 'usage' && <Usage />}
        </View>
      </ScreenScrollView>
    </Screen>
  );
}

interface CatalogueProduct {
  id: string;
  name: string;
  status: string;
  scopes: Array<string>;
  endpoints: Array<string>;
}

function Overview() {
  const { t } = useTranslation();
  const router = useRouter();
  const catalogue = useQuery({
    queryKey: ['oxy-product-catalogue'],
    queryFn: async () => {
      const response = await fetch(`${config.oxyUrl}/v1/products`);
      if (!response.ok)
        throw new Error(t('clarityPage.overview.catalogueError', { status: response.status }));
      return response.json() as Promise<{ products: Array<CatalogueProduct> }>;
    },
    staleTime: 300_000,
  });
  const product = catalogue.data?.products.find((item) => item.id === 'clarity-search');

  return (
    <>
      <ErrorNotice error={catalogue.error} />
      <View className="flex-row flex-wrap gap-4">
        <View className="min-w-72 flex-1 basis-72">
          <Card>
            <CardHeader>
              <CardTitle>{product?.name ?? t('clarityPage.overview.productFallback')}</CardTitle>
              <CardDescription>{t('clarityPage.overview.productDescription')}</CardDescription>
            </CardHeader>
            <CardBody>
              <View className="gap-3">
                {catalogue.isLoading ? (
                  <Skeleton.Box width="100%" height={48} />
                ) : product ? (
                  <View className="items-start gap-3">
                    <Badge size="label-medium" variant="solid" content={product.status} />
                    <View className="flex-row flex-wrap gap-2">
                      {product.scopes.map((scope) => (
                        <Badge key={scope} size="label-small" variant="outlined" content={scope} />
                      ))}
                    </View>
                  </View>
                ) : (
                  <Text className="text-sm text-muted-foreground">
                    {t('clarityPage.overview.notEnabled')}
                  </Text>
                )}
              </View>
            </CardBody>
          </Card>
        </View>
        <View className="min-w-72 flex-1 basis-72">
          <Card>
            <CardHeader>
              <CardTitle>{t('clarityPage.overview.resourcesTitle')}</CardTitle>
              <CardDescription>{t('clarityPage.overview.resourcesDescription')}</CardDescription>
            </CardHeader>
            <CardBody>
              <View className="gap-3">
                <GroupedSection separator="line">
                  {CLARITY_SECTIONS.slice(1).map((item) => (
                    <GroupedSectionItem
                      key={item}
                      title={t(`clarityPage.sections.${item}`)}
                      accessibilityRole="link"
                      onPress={() => router.navigate(sectionHref(item))}
                    />
                  ))}
                </GroupedSection>
              </View>
            </CardBody>
          </Card>
        </View>
      </View>
    </>
  );
}

function Search() {
  const { t } = useTranslation();
  const client = useClarityClient();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const search = useMutation({ mutationFn: () => client.search({ query, mode, limit: 20 }) });
  const submit = () => {
    if (query.trim()) search.mutate();
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('clarityPage.search.title')}</CardTitle>
          <CardDescription>{t('clarityPage.search.description')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-3">
            <View className="flex-row flex-wrap items-end gap-3">
              <View className="min-w-64 flex-1">
                <TextFieldInput
                  label={t('clarityPage.search.query')}
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t('clarityPage.search.placeholder')}
                  returnKeyType="search"
                  onSubmitEditing={submit}
                />
              </View>
              <View className="w-40">
                <Field label={t('clarityPage.search.mode')}>
                  <Select value={mode} onValueChange={(value) => setMode(value as SearchMode)}>
                    <SelectTrigger label={t('clarityPage.search.mode')}>
                      <SelectValue>{() => t(`clarityPage.search.modes.${mode}`)}</SelectValue>
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectContent
                      label={t('clarityPage.search.mode')}
                      items={SEARCH_MODES}
                      valueExtractor={(value) => value}
                      renderItem={(value) => (
                        <SelectItem value={value} label={t(`clarityPage.search.modes.${value}`)}>
                          <SelectItemIndicator />
                          <SelectItemText>{t(`clarityPage.search.modes.${value}`)}</SelectItemText>
                        </SelectItem>
                      )}
                    />
                  </Select>
                </Field>
              </View>
              <Button
                onPress={submit}
                disabled={search.isPending || !query.trim()}
                loading={search.isPending}
              >
                {t('clarityPage.search.submit')}
              </Button>
            </View>
          </View>
        </CardBody>
      </Card>
      <ErrorNotice error={search.error} />
      {search.data?.degraded && (
        <Admonition type="warning">
          {`${t('clarityPage.search.degradedTitle')} ${search.data.degraded.reason}`}
        </Admonition>
      )}
      <View className="gap-3">
        {search.data?.data.map((result) => (
          <Card key={result.id}>
            <CardHeader>
              <CardTitle>{result.title ?? result.canonicalUrl}</CardTitle>
              <CardDescription>
                {`${result.publisher ?? new URL(result.canonicalUrl).hostname} · ${result.type}`}
              </CardDescription>
            </CardHeader>
            <CardBody>
              <View className="items-start gap-2">
                <Text className="text-sm text-foreground">
                  {result.snippet ?? result.description ?? t('clarityPage.search.noSnippet')}
                </Text>
                <Button
                  appearance="plain"
                  tone="accent"
                  size="sm"
                  href={result.canonicalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {result.canonicalUrl}
                </Button>
              </View>
            </CardBody>
          </Card>
        ))}
      </View>
    </>
  );
}

function News() {
  const { t } = useTranslation();
  const client = useClarityClient();
  const news = useQuery({ queryKey: ['clarity-news'], queryFn: () => client.news({ limit: 30 }) });

  return (
    <>
      <ErrorNotice error={news.error} />
      <View className="flex-row items-center justify-between">
        <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
          {t('clarityPage.news.title')}
        </Text>
        <Button appearance="outline" onPress={() => void news.refetch()}>
          {t('clarityPage.news.refresh')}
        </Button>
      </View>
      {news.isLoading && <Skeleton.Box width="100%" height={96} />}
      <View className="flex-row flex-wrap gap-4">
        {news.data?.data.map((story) => (
          <View key={story.id} className="min-w-72 flex-1 basis-72">
            <Card>
              <CardHeader>
                <CardTitle>{story.title}</CardTitle>
                <CardDescription>
                  {t('clarityPage.news.meta', {
                    count: story.sourceCount,
                    date: new Date(story.lastPublishedAt).toLocaleString(),
                  })}
                </CardDescription>
              </CardHeader>
              <CardBody>
                <View className="gap-3">
                  <Text className="text-sm text-foreground">
                    {story.summary ?? t('clarityPage.news.noSummary')}
                  </Text>
                  <View className="gap-1">
                    {story.articles.slice(0, 3).map((article) => (
                      <Button
                        key={article.id}
                        appearance="plain"
                        tone="accent"
                        size="sm"
                        href={article.canonicalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {article.publisher ?? article.title ?? article.canonicalUrl}
                      </Button>
                    ))}
                  </View>
                </View>
              </CardBody>
            </Card>
          </View>
        ))}
      </View>
    </>
  );
}

function Indexing() {
  const { t } = useTranslation();
  const client = useClarityClient();
  const [value, setValue] = useState('');
  const submit = useMutation({
    mutationFn: () =>
      client.indexing.urls(
        { urls: value.split(/\s+/).filter(Boolean).slice(0, 50) },
        { idempotencyKey: idempotencyKey() },
      ),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('clarityPage.indexing.title')}</CardTitle>
        <CardDescription>{t('clarityPage.indexing.description')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-3">
          <Textarea
            label={t('clarityPage.indexing.urls')}
            rows={8}
            value={value}
            onChangeText={setValue}
            placeholder={'https://example.com/page\nhttps://example.com/another'}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View className="items-start">
            <Button
              disabled={submit.isPending || !value.trim()}
              loading={submit.isPending}
              onPress={() => submit.mutate()}
            >
              {t('clarityPage.indexing.submit')}
            </Button>
          </View>
          <ErrorNotice error={submit.error} />
          {submit.data && <JobSummary job={submit.data} />}
        </View>
      </CardBody>
    </Card>
  );
}

function Sites() {
  const { t } = useTranslation();
  const client = useClarityClient();
  const queryClient = useQueryClient();
  const sites = useQuery({ queryKey: ['clarity-sites'], queryFn: () => client.sites.list() });
  const [origin, setOrigin] = useState('');
  const [domainId, setDomainId] = useState('');
  const create = useMutation({
    mutationFn: () =>
      client.sites.create(
        { origin, verifiedDomainId: domainId },
        { idempotencyKey: idempotencyKey() },
      ),
    onSuccess: () => {
      setOrigin('');
      setDomainId('');
      void queryClient.invalidateQueries({ queryKey: ['clarity-sites'] });
    },
  });
  const crawl = useMutation({
    mutationFn: (id: string) => client.sites.crawl(id, { idempotencyKey: idempotencyKey() }),
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('clarityPage.sites.title')}</CardTitle>
          <CardDescription>{t('clarityPage.sites.description')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-3">
            <View className="flex-row flex-wrap items-end gap-3">
              <View className="min-w-56 flex-1">
                <TextFieldInput
                  label={t('clarityPage.sites.origin')}
                  value={origin}
                  onChangeText={setOrigin}
                  placeholder="https://example.com"
                  autoCapitalize="none"
                />
              </View>
              <View className="min-w-56 flex-1">
                <TextFieldInput
                  label={t('clarityPage.sites.domainId')}
                  value={domainId}
                  onChangeText={setDomainId}
                  placeholder={t('clarityPage.sites.domainPlaceholder')}
                  autoCapitalize="none"
                />
              </View>
              <Button
                disabled={!origin || !domainId || create.isPending}
                loading={create.isPending}
                onPress={() => create.mutate()}
              >
                {t('clarityPage.sites.register')}
              </Button>
            </View>
            <ErrorNotice error={create.error} />
          </View>
        </CardBody>
      </Card>
      <ErrorNotice error={sites.error ?? crawl.error} />
      <View className="gap-3">
        {sites.data?.data.map((site) => (
          <Card key={site.id}>
            <Item
              title={site.origin}
              subtitle={t('clarityPage.sites.status', {
                status: site.status,
                next: site.nextCrawlAt
                  ? new Date(site.nextCrawlAt).toLocaleString()
                  : t('clarityPage.sites.notScheduled'),
              })}
              trailing={
                <Button
                  appearance="outline"
                  size="sm"
                  disabled={crawl.isPending}
                  onPress={() => crawl.mutate(site.id)}
                >
                  {t('clarityPage.sites.crawl')}
                </Button>
              }
            />
          </Card>
        ))}
      </View>
      {crawl.data && <JobSummary job={crawl.data} />}
    </>
  );
}

function Jobs() {
  const { t } = useTranslation();
  const client = useClarityClient();
  const [id, setId] = useState('');
  const [requestedId, setRequestedId] = useState('');
  const job = useQuery({
    queryKey: ['clarity-job', requestedId],
    queryFn: () => client.jobs.get(requestedId),
    enabled: Boolean(requestedId),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.status ?? '') ? 2000 : false,
  });
  const cancel = useMutation({
    mutationFn: () => client.jobs.cancel(requestedId, { idempotencyKey: idempotencyKey() }),
    onSuccess: () => void job.refetch(),
  });
  const inspect = () => setRequestedId(id.trim());

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('clarityPage.jobs.title')}</CardTitle>
        <CardDescription>{t('clarityPage.jobs.description')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-3">
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <TextFieldInput
                label={t('clarityPage.jobs.id')}
                value={id}
                onChangeText={setId}
                placeholder={t('clarityPage.jobs.id')}
                autoCapitalize="none"
                returnKeyType="go"
                onSubmitEditing={inspect}
              />
            </View>
            <Button disabled={!id.trim()} onPress={inspect}>
              {t('clarityPage.jobs.inspect')}
            </Button>
          </View>
          <ErrorNotice error={job.error ?? cancel.error} />
          {job.data && (
            <>
              <JobSummary job={job.data} />
              {['queued', 'running'].includes(job.data.status) && (
                <View className="items-start">
                  <Button tone="danger" onPress={() => cancel.mutate()} loading={cancel.isPending}>
                    {t('clarityPage.jobs.cancel')}
                  </Button>
                </View>
              )}
            </>
          )}
        </View>
      </CardBody>
    </Card>
  );
}

function JobSummary({ job }: { job: Job }) {
  const { t } = useTranslation();
  return (
    <GroupedSection>
      <Item
        title={t('clarityPage.job.kind', { kind: job.kind })}
        subtitle={`${t('clarityPage.job.progress', {
          done: job.pagesCompleted,
          total: job.pagesDiscovered,
        })} · ${job.id}`}
        trailing={<Badge size="label-small" variant="outlined" content={job.status} />}
      />
    </GroupedSection>
  );
}

function Usage() {
  const { t } = useTranslation();
  const client = useClarityClient();
  const usage = useQuery({ queryKey: ['clarity-usage'], queryFn: () => client.usage.get() });
  const quotas = useQuery({ queryKey: ['clarity-quotas'], queryFn: () => client.usage.quotas() });

  return (
    <>
      <ErrorNotice error={usage.error ?? quotas.error} />
      <View className="flex-row flex-wrap gap-4">
        <View className="min-w-72 flex-1 basis-72">
          <Card>
            <CardHeader>
              <CardTitle>{t('clarityPage.usage.quotasTitle')}</CardTitle>
              <CardDescription>{t('clarityPage.usage.quotasDescription')}</CardDescription>
            </CardHeader>
            <CardBody>
              <View className="gap-3">
                {quotas.isLoading ? (
                  <Skeleton.Box width="100%" height={48} />
                ) : (
                  quotas.data && (
                    <GroupedSection separator="line">
                      {Object.entries(quotas.data).map(([key, value]) => (
                        <GroupedSectionItem key={key} title={key} value={value.toLocaleString()} />
                      ))}
                    </GroupedSection>
                  )
                )}
              </View>
            </CardBody>
          </Card>
        </View>
        <View className="min-w-72 flex-1 basis-72">
          <Card>
            <CardHeader>
              <CardTitle>{t('clarityPage.usage.measuredTitle')}</CardTitle>
              <CardDescription>{t('clarityPage.usage.measuredDescription')}</CardDescription>
            </CardHeader>
            <CardBody>
              <View className="gap-3">
                {usage.isLoading ? (
                  <Skeleton.Box width="100%" height={48} />
                ) : usage.data?.data.length ? (
                  <GroupedSection separator="line">
                    {usage.data.data.map((row) => (
                      <GroupedSectionItem
                        key={`${row.operation}-${row.periodStart}`}
                        title={row.operation}
                        value={row.quantity.toLocaleString()}
                      />
                    ))}
                  </GroupedSection>
                ) : (
                  <Text className="text-sm text-muted-foreground">
                    {t('clarityPage.usage.none')}
                  </Text>
                )}
              </View>
            </CardBody>
          </Card>
        </View>
      </View>
    </>
  );
}
