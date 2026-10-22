import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import type { Site } from '@clarity.surf/sdk';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { useClaritySites, useCrawlSite, useRegisterSite } from '@/hooks/use-clarity';
import { useTranslation } from '@/lib/i18n';
import { JobSummary } from './JobSummary';

/** Register a verified site, and start a crawl of one already registered. */
export function ClaritySites() {
  const { t } = useTranslation();
  const sites = useClaritySites();
  const register = useRegisterSite();
  const crawl = useCrawlSite();
  const [origin, setOrigin] = useState('');
  const [domainId, setDomainId] = useState('');

  const columns = useMemo<Array<DataTableColumn<Site>>>(
    () => [
      {
        id: 'origin',
        header: t('clarityPage.sites.origin'),
        basis: 280,
        accessor: (site) => site.origin,
      },
      {
        id: 'status',
        header: t('clarityPage.sites.statusColumn'),
        basis: 120,
        accessor: (site) => site.status,
        cell: ({ row }) => <Chip size="sm">{row.status}</Chip>,
      },
      {
        id: 'next',
        header: t('clarityPage.sites.nextCrawl'),
        basis: 200,
        accessor: (site) => site.nextCrawlAt,
        cell: ({ row }) =>
          row.nextCrawlAt
            ? new Date(row.nextCrawlAt).toLocaleString()
            : t('clarityPage.sites.notScheduled'),
      },
      {
        id: 'crawl',
        header: '',
        headerAccessibilityLabel: t('clarityPage.sites.crawl'),
        width: 140,
        cell: ({ row }) => (
          <Button
            appearance="outline"
            size="sm"
            disabled={crawl.isPending}
            onPress={() => crawl.mutate(row.id)}
          >
            {t('clarityPage.sites.crawl')}
          </Button>
        ),
      },
    ],
    [t, crawl],
  );

  return (
    <View className="gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('clarityPage.sites.title')}</CardTitle>
          <CardDescription>{t('clarityPage.sites.description')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-4">
            <TextFieldInput
              label={t('clarityPage.sites.origin')}
              value={origin}
              onChangeText={setOrigin}
              placeholder="https://example.com"
              autoCapitalize="none"
            />
            <TextFieldInput
              label={t('clarityPage.sites.domainId')}
              value={domainId}
              onChangeText={setDomainId}
              placeholder={t('clarityPage.sites.domainPlaceholder')}
              autoCapitalize="none"
            />
            <View className="items-start">
              <Button
                disabled={!origin.trim() || !domainId.trim() || register.isPending}
                loading={register.isPending}
                onPress={() =>
                  register.mutate(
                    { origin: origin.trim(), verifiedDomainId: domainId.trim() },
                    {
                      onSuccess: () => {
                        setOrigin('');
                        setDomainId('');
                        toast.success(t('clarityPage.sites.registered'));
                      },
                    },
                  )
                }
              >
                {t('clarityPage.sites.register')}
              </Button>
            </View>
          </View>
        </CardBody>
      </Card>

      {register.isError && <ApiState error={register.error} />}
      {crawl.isError && <ApiState error={crawl.error} />}
      {crawl.data && <JobSummary job={crawl.data} />}

      {sites.isLoading ? (
        <TableSkeleton columns={4} />
      ) : sites.isError ? (
        <ApiState error={sites.error} onRetry={sites.refetch} />
      ) : (
        <DataTable
          layout="inset"
          rows={sites.data?.data ?? []}
          columns={columns}
          getRowId={(site) => site.id}
          accessibilityLabel={t('clarityPage.sections.sites')}
          title={t('clarityPage.sections.sites')}
          pageSize={10}
          minWidth={640}
          emptyState={<EmptyState variant="compact" title={t('clarityPage.sites.none')} />}
        />
      )}
    </View>
  );
}
