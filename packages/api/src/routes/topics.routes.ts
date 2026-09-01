import express, { type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireStaff } from '../middleware/requireStaff';
import { topicService, type TopicType } from '../services/TopicService.js';
import { TOPIC_TYPES } from '../db/schema/topics';

const router = express.Router();

// ─── Public routes ───────────────────────────────────────────────────────────

/**
 * GET /
 * List topics with optional filters.
 * Query: type, q, limit (max 100), offset, locale
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as TopicType | undefined;
    const query = req.query.q as string | undefined;
    const locale = req.query.locale as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // `TOPIC_TYPES` is the same `const` tuple the column's `enum` and its CHECK
    // constraint are built from, so this 400 cannot drift from what the
    // database would accept.
    if (type && !TOPIC_TYPES.includes(type)) {
      return res.status(400).json({ error: 'INVALID_TYPE', message: `type must be one of: ${TOPIC_TYPES.join(', ')}` });
    }

    const { topics, total } = await topicService.list({ type, query, limit, offset });
    const localized = locale ? topicService.localizeTopics(topics, locale) : topics;

    res.json({ topics: localized, total, limit, offset });
  } catch (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /categories
 * All category-type topics, sorted alphabetically.
 * Query: locale
 */
router.get('/categories', async (req: Request, res: Response) => {
  try {
    const locale = req.query.locale as string | undefined;
    const categories = await topicService.getCategories();
    const localized = locale ? topicService.localizeTopics(categories, locale) : categories;

    res.json({ categories: localized });
  } catch (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /search
 * Autocomplete / text search.
 * Query: q (required), limit (max 50)
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string | undefined;
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'MISSING_QUERY', message: 'q parameter is required' });
    }

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const topics = await topicService.search(query, limit);

    res.json({ topics });
  } catch (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /:slug
 * Single topic by slug.
 */
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const topic = await topicService.getBySlug(req.params.slug);
    if (!topic) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Topic not found' });
    }

    const locale = req.query.locale as string | undefined;
    const [localized] = locale ? topicService.localizeTopics([topic], locale) : [topic];

    res.json(localized);
  } catch (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Auth-required routes ────────────────────────────────────────────────────

router.use(authMiddleware);

/**
 * POST /resolve
 * Batch resolve names to topics (upsert).
 * Body: { names: Array<{ name: string; type: TopicType }> }
 */
router.post('/resolve', requireStaff, async (req: Request, res: Response) => {
  try {
    const { names } = req.body;
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'INVALID_BODY', message: 'names must be a non-empty array' });
    }

    const resolved = await topicService.resolveNames(names);
    const topics = Object.fromEntries(resolved);

    res.json({ topics });
  } catch (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * PATCH /:slug
 * Update topic metadata (description, translations, icon, image, aliases).
 */
router.patch('/:slug', requireStaff, async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    // An explicit per-column whitelist, never a spread of `req.body`: drizzle
    // keys `set()` by column PROPERTY and silently ignores an unknown key, so a
    // loop over a string array would fail open on a renamed column rather than
    // erroring.
    const body = req.body as Record<string, unknown>;
    const update: Parameters<typeof topicService.updateBySlug>[1] = {};
    if (typeof body.description === 'string') update.description = body.description;
    if (typeof body.displayName === 'string') update.displayName = body.displayName;
    if (typeof body.icon === 'string') update.icon = body.icon;
    if (typeof body.image === 'string') update.image = body.image;
    if (Array.isArray(body.aliases) && body.aliases.every((a) => typeof a === 'string')) {
      update.aliases = body.aliases;
    }
    if (body.translations !== undefined) update.translations = body.translations;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'EMPTY_UPDATE', message: 'No valid fields to update' });
    }

    const topic = await topicService.updateBySlug(slug, update);

    if (!topic) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Topic not found' });
    }

    res.json(topic);
  } catch (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
