import { ClarityClient, type SearchMode } from '@clarity.surf/sdk';
import { useAuth } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import config from '@/lib/config';

/** Clarity authenticates the currently active Oxy account session by introspection. */
export function useClarityClient(): ClarityClient {
  const { oxyServices } = useAuth();

  return useMemo(
    () =>
      new ClarityClient({
        baseUrl: config.clarityUrl,
        // The SDK calls this as a method of itself; a bare `fetch` throws "Illegal invocation".
        fetch: (input, init) => fetch(input, init),
        getAccessToken: () => {
          const token = oxyServices.session.accessToken;
          if (!token) throw new Error('Your Oxy session is not ready.');
          return token;
        },
      }),
    [oxyServices],
  );
}

/** Every write carries its own key, so a double-press cannot queue the work twice. */
const idempotencyKey = () => ({ idempotencyKey: crypto.randomUUID() });

const keys = {
  product: ['oxy-product-catalogue'] as const,
  news: ['clarity-news'] as const,
  sites: ['clarity-sites'] as const,
  job: (id: string) => ['clarity-job', id] as const,
  usage: ['clarity-usage'] as const,
  quotas: ['clarity-quotas'] as const,
};

interface CatalogueProduct {
  id: string;
  name: string;
  status: string;
  scopes: Array<string>;
  endpoints: Array<string>;
}

/** The Clarity entry of Oxy's product catalogue (`undefined` when it is not enabled). */
export function useClarityProduct() {
  return useQuery({
    queryKey: keys.product,
    queryFn: async () => {
      const response = await fetch(`${config.oxyUrl}/v1/products`);
      if (!response.ok) {
        throw Object.assign(new Error('catalogue'), { status: response.status });
      }
      const body = (await response.json()) as { products: Array<CatalogueProduct> };
      return body.products.find((product) => product.id === 'clarity-search');
    },
    staleTime: 300_000,
  });
}

export function useClaritySearch() {
  const client = useClarityClient();
  return useMutation({
    mutationFn: ({ query, mode }: { query: string; mode: SearchMode }) =>
      client.search({ query, mode, limit: 20 }),
  });
}

export function useClarityNews() {
  const client = useClarityClient();
  return useQuery({ queryKey: keys.news, queryFn: () => client.news({ limit: 30 }) });
}

/** Queue up to 50 public URLs. */
export function useIndexUrls() {
  const client = useClarityClient();
  return useMutation({
    mutationFn: (urls: Array<string>) =>
      client.indexing.urls({ urls: urls.slice(0, 50) }, idempotencyKey()),
  });
}

export function useClaritySites() {
  const client = useClarityClient();
  return useQuery({ queryKey: keys.sites, queryFn: () => client.sites.list() });
}

export function useRegisterSite() {
  const client = useClarityClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (site: { origin: string; verifiedDomainId: string }) =>
      client.sites.create(site, idempotencyKey()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.sites }),
  });
}

export function useCrawlSite() {
  const client = useClarityClient();
  return useMutation({
    mutationFn: (siteId: string) => client.sites.crawl(siteId, idempotencyKey()),
  });
}

/** One job, polled every two seconds while it is queued or running. */
export function useClarityJob(jobId: string) {
  const client = useClarityClient();
  return useQuery({
    queryKey: keys.job(jobId),
    queryFn: () => client.jobs.get(jobId),
    enabled: jobId !== '',
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.status ?? '') ? 2000 : false,
  });
}

export function useCancelJob(jobId: string) {
  const client = useClarityClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.jobs.cancel(jobId, idempotencyKey()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.job(jobId) }),
  });
}

export function useClarityUsage() {
  const client = useClarityClient();
  return useQuery({ queryKey: keys.usage, queryFn: () => client.usage.get() });
}

export function useClarityQuotas() {
  const client = useClarityClient();
  return useQuery({ queryKey: keys.quotas, queryFn: () => client.usage.quotas() });
}
