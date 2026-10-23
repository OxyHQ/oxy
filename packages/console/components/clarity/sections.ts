import type { Href } from 'expo-router';

/** The Clarity tabs, in order; each is its own route under `/clarity`. */
export const CLARITY_SECTIONS = [
  { id: 'overview', href: '/clarity' },
  { id: 'search', href: '/clarity/search' },
  { id: 'news', href: '/clarity/news' },
  { id: 'indexing', href: '/clarity/indexing' },
  { id: 'sites', href: '/clarity/sites' },
  { id: 'jobs', href: '/clarity/jobs' },
  { id: 'usage', href: '/clarity/usage' },
] as const satisfies ReadonlyArray<{ id: string; href: Href }>;

export type ClaritySectionId = (typeof CLARITY_SECTIONS)[number]['id'];
