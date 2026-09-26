/**
 * `oxy.topics` — the shared topic catalogue.
 */
import type { OxyContext } from '../client/context';
import type { TopicData, TopicListResult, TopicTranslation } from '../models/Topic';

const SHORT = 60 * 1000;
const LONG = 5 * 60 * 1000;
const EXTRA_LONG = 30 * 60 * 1000;

export interface TopicListOptions {
  type?: string;
  q?: string;
  limit?: number;
  offset?: number;
  locale?: string;
}

export class TopicsApi {
  constructor(protected readonly ctx: OxyContext) {}

  /** Topics, filtered and paginated; returns the page with `total`/`limit`/`offset`. */
  async list(options: TopicListOptions = {}): Promise<TopicListResult> {
    const params: Record<string, string | number> = {};
    if (options.type) params.type = options.type;
    if (options.q) params.q = options.q;
    if (options.limit) params.limit = options.limit;
    if (options.offset) params.offset = options.offset;
    if (options.locale) params.locale = options.locale;
    const res = await this.ctx.request<Partial<TopicListResult>>('GET', '/topics', params, {
      cache: true,
      cacheTTL: SHORT,
    });
    return {
      topics: res.topics ?? [],
      total: res.total ?? res.topics?.length ?? 0,
      limit: res.limit ?? options.limit ?? 0,
      offset: res.offset ?? options.offset ?? 0,
    };
  }

  /** Topics matching `query`. Never cached. */
  async search(query: string, limit?: number): Promise<TopicData[]> {
    const params: Record<string, string | number> = { q: query };
    if (limit) params.limit = limit;
    const res = await this.ctx.request<{ topics?: TopicData[] }>('GET', '/topics/search', params, { cache: false });
    return res.topics ?? [];
  }

  /** One topic by slug. */
  async get(slug: string): Promise<TopicData> {
    return this.ctx.request<TopicData>('GET', `/topics/${slug}`, undefined, { cache: true, cacheTTL: LONG });
  }

  /** The top-level categories, optionally translated. */
  async categories(locale?: string): Promise<TopicData[]> {
    const res = await this.ctx.request<{ categories?: TopicData[] }>(
      'GET',
      '/topics/categories',
      locale ? { locale } : {},
      { cache: true, cacheTTL: EXTRA_LONG },
    );
    return res.categories ?? [];
  }

  /** Resolve names to topics, creating the missing ones. Staff or service only. */
  async resolveNames(names: Array<{ name: string; type: string }>): Promise<TopicData[]> {
    const res = await this.ctx.request<{ topics?: Record<string, TopicData> }>('POST', '/topics/resolve', { names }, {
      cache: false,
    });
    return Object.values(res.topics ?? {});
  }

  /** Update a topic's description and translations. Staff or service only. */
  async update(
    slug: string,
    data: { description?: string; translations?: Record<string, TopicTranslation> },
  ): Promise<TopicData> {
    const topic = await this.ctx.request<TopicData>('PATCH', `/topics/${slug}`, data, { cache: false });
    this.ctx.oxy.cache.delete(`GET:/topics/${slug}`);
    return topic;
  }
}
