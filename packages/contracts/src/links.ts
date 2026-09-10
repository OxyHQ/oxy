/**
 * Link-preview / unfurl API contracts.
 *
 * SINGLE SOURCE OF TRUTH for the wire shape of Oxy's link-preview ("unfurl")
 * resolution surface: the single `GET` lookup and the `POST` batch lookup that
 * every app calls through the SDK so apps stop duplicating their own
 * link-metadata fetching. The API validates its OUTPUT against these schemas;
 * every consumer (`@oxy.so/core`'s link mixin and the apps that call it)
 * validates its INPUT against the same definitions, so producer and consumers
 * cannot drift.
 *
 * Design anchors:
 *  - Oxy owns resolution. The `image` (and `favicon`) URLs a preview carries are
 *    re-hosted on Oxy media (`cloud.oxy.so/<fileId>`), never raw remote URLs —
 *    apps render them directly with no per-app proxy.
 *  - Resolution is best-effort and asynchronous. A preview is `'resolved'` once
 *    metadata is materialised, `'pending'` while a first-seen URL is being
 *    fetched in the background, or `'empty'` when the target yielded no usable
 *    metadata. `resolvedAt` (ISO datetime) is present only once `'resolved'`.
 *  - The batch response is keyed by the REQUESTED url (the exact string the
 *    caller sent), not the canonical/final URL, so a caller can always look its
 *    own input back up; the canonical URL lives on `LinkPreview.url`.
 *
 * The `LinkPreview` / `LinkPreviewBatchResponse` exports are declared as explicit
 * `interface`s (with their runtime schemas annotated `z.ZodType<Interface>`),
 * following the same rationale as `UserNameResponse` in `./userResponse`: a
 * `z.infer<>` of a nested-object schema can degrade to `{}` under a consumer's
 * `moduleResolution: "node"` (node10) resolution. A literal interface emits the
 * field types verbatim in the `.d.ts` and survives BOTH `node` and `bundler`
 * resolution. The flat batch-request schema (no nested-object hazard) is inferred
 * via `z.infer<>`.
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Link preview                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolution state of a {@link LinkPreview}.
 *
 * - `resolved` — metadata materialised; `resolvedAt` is present.
 * - `pending`  — a first-seen URL is being fetched in the background; metadata
 *   fields and `resolvedAt` may be absent. The caller may re-fetch shortly.
 * - `empty`    — the target yielded no usable metadata (e.g. a bare binary, a
 *   404, or an opted-out host); the negative result is cached.
 */
export type LinkPreviewStatus = 'resolved' | 'pending' | 'empty';

/**
 * A single resolved (or in-flight) link preview.
 *
 * `url` is the canonical / final resolved URL (after redirects). The optional
 * metadata fields are present on a best-effort basis once `status` is
 * `'resolved'`. `image` and `favicon` are absolute Oxy-hosted
 * (`cloud.oxy.so/<fileId>`) URLs — render them directly, never proxy them.
 */
export interface LinkPreview {
    /** Canonical / final resolved URL (after following redirects). */
    url: string;
    status: LinkPreviewStatus;
    title?: string;
    description?: string;
    /** Absolute Oxy-hosted (`cloud.oxy.so`) image URL. */
    image?: string;
    siteName?: string;
    /** Absolute Oxy-hosted (`cloud.oxy.so`) favicon URL. */
    favicon?: string;
    /** ISO 8601 datetime of resolution; absent while `status` is `'pending'`. */
    resolvedAt?: string;
}

export const linkPreviewSchema: z.ZodType<LinkPreview> = z.object({
    url: z.string(),
    status: z.enum(['resolved', 'pending', 'empty']),
    title: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    siteName: z.string().optional(),
    favicon: z.string().optional(),
    resolvedAt: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/*  Batch request / response                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Request body for the batch unfurl endpoint. Between 1 and 50 URLs per call;
 * the server resolves each (returning a `'pending'` placeholder for any URL it
 * has not seen before and is fetching in the background).
 */
export const linkPreviewBatchRequestSchema = z.object({
    urls: z.array(z.string().max(2048)).min(1).max(50),
});

export type LinkPreviewBatchRequest = z.infer<typeof linkPreviewBatchRequestSchema>;

/**
 * Batch unfurl response. `data` is keyed by the REQUESTED url (the exact string
 * the caller sent in `urls`), so a caller can always look its own input back up;
 * the canonical/final URL is on each {@link LinkPreview}'s `url` field.
 */
export interface LinkPreviewBatchResponse {
    data: Record<string, LinkPreview>;
}

export const linkPreviewBatchResponseSchema: z.ZodType<LinkPreviewBatchResponse> = z.object({
    data: z.record(z.string(), linkPreviewSchema),
});

/**
 * Wire shape of the single-URL unfurl lookup (`GET`) — a bare
 * {@link LinkPreview}.
 */
export const linkPreviewResponseSchema = linkPreviewSchema;
