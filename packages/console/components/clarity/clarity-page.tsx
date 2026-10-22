import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Job, SearchMode } from '@clarity.surf/sdk';
import { type Href, Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ContentScreen } from '@/components/content/ContentScreen';
import { Notice } from '@/components/content/Notice';
import { OptionSelect } from '@/components/content/OptionSelect';
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
    <Notice
      tone="danger"
      title={t('clarityPage.error.title')}
      paragraphs={[error instanceof Error ? error.message : t('clarityPage.error.unexpected')]}
    />
  );
}

/** A card with a title, a description and a body. */
function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="gap-3 p-5">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
          {title}
        </Text>
        {description !== undefined && (
          <Text className="text-sm text-muted-foreground">{description}</Text>
        )}
      </View>
      {children}
    </Card>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href as Href} target="_blank" asChild>
      <Text accessibilityRole="link" className="text-sm text-primary underline" numberOfLines={1}>
        {children}
      </Text>
    </Link>
  );
}

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-4 border-b border-border py-2">
      <Text className="text-sm text-foreground">{label}</Text>
      <Text className="text-sm font-semibold text-foreground">{value}</Text>
    </View>
  );
}

export function ClarityPage({ section }: { section: ClaritySection }) {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <ContentScreen
      title={t('clarityPage.title')}
      subtitle={t('clarityPage.subtitle')}
      maxWidth="xl"
      actions={<Badge size="label-medium" variant="subtle" content={t('clarityPage.beta')} />}
    >
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
    </ContentScreen>
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
          <Panel
            title={product?.name ?? t('clarityPage.overview.productFallback')}
            description={t('clarityPage.overview.productDescription')}
          >
            {catalogue.isLoading ? (
              <Text className="text-sm text-muted-foreground">
                {t('clarityPage.overview.loading')}
              </Text>
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
          </Panel>
        </View>
        <View className="min-w-72 flex-1 basis-72">
          <Panel
            title={t('clarityPage.overview.resourcesTitle')}
            description={t('clarityPage.overview.resourcesDescription')}
          >
            <View className="flex-row flex-wrap gap-2">
              {CLARITY_SECTIONS.slice(1).map((item) => (
                <Link key={item} href={sectionHref(item)} asChild>
                  <Pressable
                    accessibilityRole="link"
                    className="min-w-32 flex-1 rounded-md border border-border p-3 hover:bg-muted"
                  >
                    <Text className="text-sm text-foreground">
                      {t(`clarityPage.sections.${item}`)}
                    </Text>
                  </Pressable>
                </Link>
              ))}
            </View>
          </Panel>
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
      <Panel
        title={t('clarityPage.search.title')}
        description={t('clarityPage.search.description')}
      >
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
          <OptionSelect
            className="w-40"
            label={t('clarityPage.search.mode')}
            value={mode}
            options={SEARCH_MODES.map((value) => ({
              value,
              label: t(`clarityPage.search.modes.${value}`),
            }))}
            onChange={(value) => setMode(value as SearchMode)}
          />
          <Button
            onPress={submit}
            disabled={search.isPending || !query.trim()}
            loading={search.isPending}
          >
            {t('clarityPage.search.submit')}
          </Button>
        </View>
      </Panel>
      <ErrorNotice error={search.error} />
      {search.data?.degraded && (
        <Notice
          title={t('clarityPage.search.degradedTitle')}
          paragraphs={[search.data.degraded.reason]}
        />
      )}
      <View className="gap-3">
        {search.data?.data.map((result) => (
          <Card key={result.id} className="gap-2 p-5">
            <ExternalLink href={result.canonicalUrl}>
              {result.title ?? result.canonicalUrl}
            </ExternalLink>
            <Text className="text-sm text-muted-foreground">
              {`${result.publisher ?? new URL(result.canonicalUrl).hostname} · ${result.type}`}
            </Text>
            <Text className="text-sm text-foreground">
              {result.snippet ?? result.description ?? t('clarityPage.search.noSnippet')}
            </Text>
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
      {news.isLoading && (
        <Text className="text-sm text-muted-foreground">{t('clarityPage.news.loading')}</Text>
      )}
      <View className="flex-row flex-wrap gap-4">
        {news.data?.data.map((story) => (
          <View key={story.id} className="min-w-72 flex-1 basis-72">
            <Panel
              title={story.title}
              description={t('clarityPage.news.meta', {
                count: story.sourceCount,
                date: new Date(story.lastPublishedAt).toLocaleString(),
              })}
            >
              <Text className="text-sm text-foreground">
                {story.summary ?? t('clarityPage.news.noSummary')}
              </Text>
              <View className="gap-1">
                {story.articles.slice(0, 3).map((article) => (
                  <ExternalLink key={article.id} href={article.canonicalUrl}>
                    {article.publisher ?? article.title ?? article.canonicalUrl}
                  </ExternalLink>
                ))}
              </View>
            </Panel>
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
    <Panel
      title={t('clarityPage.indexing.title')}
      description={t('clarityPage.indexing.description')}
    >
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
    </Panel>
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
      <Panel title={t('clarityPage.sites.title')} description={t('clarityPage.sites.description')}>
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
      </Panel>
      <ErrorNotice error={sites.error ?? crawl.error} />
      <View className="gap-3">
        {sites.data?.data.map((site) => (
          <Card key={site.id} className="flex-row flex-wrap items-center justify-between gap-3 p-5">
            <View className="gap-0.5">
              <Text selectable className="text-sm font-medium text-foreground">
                {site.origin}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t('clarityPage.sites.status', {
                  status: site.status,
                  next: site.nextCrawlAt
                    ? new Date(site.nextCrawlAt).toLocaleString()
                    : t('clarityPage.sites.notScheduled'),
                })}
              </Text>
            </View>
            <Button
              appearance="outline"
              disabled={crawl.isPending}
              onPress={() => crawl.mutate(site.id)}
            >
              {t('clarityPage.sites.crawl')}
            </Button>
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
    <Panel title={t('clarityPage.jobs.title')} description={t('clarityPage.jobs.description')}>
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
    </Panel>
  );
}

function JobSummary({ job }: { job: Job }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1 rounded-md border border-border p-4">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-sm font-semibold text-foreground">
          {t('clarityPage.job.kind', { kind: job.kind })}
        </Text>
        <Badge size="label-small" variant="outlined" content={job.status} />
      </View>
      <Text className="text-sm text-muted-foreground">
        {t('clarityPage.job.progress', {
          done: job.pagesCompleted,
          total: job.pagesDiscovered,
        })}
      </Text>
      <Text selectable className="text-xs text-muted-foreground">
        {job.id}
      </Text>
    </View>
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
          <Panel
            title={t('clarityPage.usage.quotasTitle')}
            description={t('clarityPage.usage.quotasDescription')}
          >
            {quotas.isLoading ? (
              <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
            ) : (
              quotas.data &&
              Object.entries(quotas.data).map(([key, value]) => (
                <KeyValueRow key={key} label={key} value={value.toLocaleString()} />
              ))
            )}
          </Panel>
        </View>
        <View className="min-w-72 flex-1 basis-72">
          <Panel
            title={t('clarityPage.usage.measuredTitle')}
            description={t('clarityPage.usage.measuredDescription')}
          >
            {usage.isLoading ? (
              <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
            ) : usage.data?.data.length ? (
              usage.data.data.map((row) => (
                <KeyValueRow
                  key={`${row.operation}-${row.periodStart}`}
                  label={row.operation}
                  value={row.quantity.toLocaleString()}
                />
              ))
            ) : (
              <Text className="text-sm text-muted-foreground">{t('clarityPage.usage.none')}</Text>
            )}
          </Panel>
        </View>
      </View>
    </>
  );
}
