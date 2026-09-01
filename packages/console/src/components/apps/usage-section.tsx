import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import { Button } from '@/components/ui/button';
import { useApplicationUsage } from '@/hooks/use-applications';

const PERIODS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
];

interface UsageSectionProps {
  application: Application;
  access: CallerAccess;
}

export function UsageSection({ application, access }: UsageSectionProps) {
  const canRead = access.can('usage:read');
  const [period, setPeriod] = useState('7d');
  const { data: usage, isLoading } = useApplicationUsage(application._id, period, canRead);

  if (!canRead) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        You do not have permission to view usage.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Platform API usage</h2>
          {/*
            Named for what it is, because a second usage view now exists beside
            it. These are the legacy per-credential counters over the whole
            platform API, and "credits" here is the product credit unit — not
            money, and not the inference ledger. Inference units and inference
            spend are under Inference → Usage and spend, which reads
            `/inference/reporting` and says which of its figures is a bill.
          */}
          <p className="text-sm text-muted-foreground">
            Platform API calls made with this application's credentials. Inference units and spend
            are under Inference → Usage and spend.
          </p>
        </div>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <Button
              key={p.value}
              variant={period === p.value ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Overview */}
      <section>
        <p className="text-sm font-semibold text-foreground mb-4">Overview</p>
        {isLoading ? (
          <div className="flex flex-row gap-12">
            {[1, 2, 3].map((i) => (
              <Skeleton.Box key={i} width={96} height={48} />
            ))}
          </div>
        ) : (
          <div className="flex flex-row flex-wrap gap-12">
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(usage?.summary?.totalRequests ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Total requests</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(usage?.summary?.totalTokens ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Total tokens</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(usage?.summary?.totalCredits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Credits used</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {Math.round(usage?.summary?.avgResponseTime ?? 0)}ms
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Avg response</p>
            </div>
          </div>
        )}
      </section>

      {/* Usage by day */}
      <section>
        <p className="text-sm font-semibold text-foreground mb-4">Usage by day</p>
        {isLoading ? (
          <div className="h-24 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : usage?.byDay && usage.byDay.length > 0 ? (
          <div className="space-y-2">
            {usage.byDay.map((day) => (
              <div
                key={day._id}
                className="flex items-center justify-between py-2 border-b border-border last:border-0"
              >
                <p className="text-sm text-foreground">{day._id}</p>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>{day.requests.toLocaleString()} requests</span>
                  <span>{day.tokens.toLocaleString()} tokens</span>
                  <span>{day.credits.toLocaleString()} credits</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No usage data available for this period
          </div>
        )}
      </section>

      {/* Usage by endpoint */}
      <section>
        <p className="text-sm font-semibold text-foreground mb-4">Usage by endpoint</p>
        {isLoading ? (
          <div className="h-24 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : usage?.byEndpoint && usage.byEndpoint.length > 0 ? (
          <div className="space-y-2">
            {usage.byEndpoint.map((endpoint) => (
              <div
                key={endpoint._id}
                className="flex items-center justify-between py-2 border-b border-border last:border-0"
              >
                <p className="text-sm text-foreground font-mono">{endpoint._id}</p>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>{endpoint.requests.toLocaleString()} requests</span>
                  <span>{endpoint.tokens.toLocaleString()} tokens</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No endpoint data available for this period
          </div>
        )}
      </section>
    </div>
  );
}
