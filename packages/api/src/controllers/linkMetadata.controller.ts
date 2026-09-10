import type { Request, Response } from 'express';
import { normalizeInlineText } from '@oxy.so/core';
import { logger } from '../utils/logger';
import { linkPreviewService } from '../services/linkPreview/linkPreviewService';

interface LinkMetadata {
    url: string;
    title: string;
    description: string;
    image?: string;
}

export const fetchLinkMetadata = async (req: Request, res: Response) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
    }

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const preview = await linkPreviewService.get(trimmedUrl, { wait: true });
        // The title/description come from a REMOTE page and are single-line card
        // values: a `<title>` authored across indented source lines carries real
        // newlines, and clients render this response in an RN `Text`
        // (`white-space: pre-wrap`), which preserves them. A bare `.trim()` only
        // ever fixed the ends. The stored copy on the profile is normalized again
        // on write (`utils/profileTextNormalization.ts`) — this response is what a
        // composer/profile editor echoes straight back, so it must already be clean.
        const title = preview.title ? normalizeInlineText(preview.title) : '';
        const description = preview.description ? normalizeInlineText(preview.description) : '';
        const metadata: LinkMetadata = {
            url: preview.url,
            title: title || preview.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
            description: description || 'Link',
            image: preview.image,
        };

        res.json(metadata);
    } catch (error: unknown) {
        logger.error('Error fetching link metadata', error instanceof Error ? error : new Error(String(error)));

        const fallbackUrl = trimmedUrl.startsWith('http') ? trimmedUrl : `https://${trimmedUrl}`;
        res.json({
            url: fallbackUrl,
            title: fallbackUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
            description: 'Link',
            image: undefined,
        });
    }
};
