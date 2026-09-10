import express from 'express';

const router = express.Router();

/** Oxy-owned, customer-safe catalogue of API products and their authority. */
export const PRODUCT_API_CATALOGUE = {
  version: 1,
  products: [
    {
      id: 'inference',
      name: 'Inference API',
      status: 'available',
      documentation: '/docs/inference',
      scopes: ['inference:invoke', 'inference:models:read', 'inference:usage:read'],
      endpoints: ['/v1/responses', '/v1/chat/completions', '/v1/models'],
    },
    {
      id: 'clarity-search',
      name: 'Clarity Search, Indexing & News',
      status: 'beta',
      documentation: 'https://clarity.oxy.so/docs',
      scopes: [
        'clarity:search',
        'clarity:index',
        'clarity:sites:manage',
        'clarity:usage:read',
      ],
      endpoints: [
        '/v1/search',
        '/v1/news',
        '/v1/resolve',
        '/v1/index/urls',
        '/v1/documents/:id',
        '/v1/sites',
        '/v1/jobs/:id',
        '/v1/usage',
        '/v1/quotas',
      ],
    },
  ],
} as const;

router.get('/', (_request, response) => {
  response.set('cache-control', 'public, max-age=300, must-revalidate');
  response.json(PRODUCT_API_CATALOGUE);
});

export default router;
