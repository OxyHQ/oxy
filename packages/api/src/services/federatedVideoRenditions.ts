import { FEDERATION_MEDIA_CACHE_PURPOSE } from '../constants/federationCache';
import type { FileRecord } from '../types/file.types';

/**
 * Containers every supported client plays progressively. Federated video is
 * almost all `video/mp4` (925 of 926 in six hours on 2026-11-28: Mastodon and
 * most servers already transcode uploads to H.264 MP4). Anything else, such as
 * QuickTime, keeps its compatibility encode.
 */
const PROGRESSIVE_VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

/**
 * Whether a VIDEO's ordinary background generation skips the encoded ladder.
 *
 * A federated video (Mention's durable copy of a remote post's media, or a
 * media-cache entry) is a copy of bytes another server already serves. Encoding
 * it into three x264 rungs plus HLS made the asset-variant worker upload about
 * 3-4x the original from AWS to R2 for every one: about 200 GB a day, the
 * largest line of the AWS bill (internet egress, measured with VPC Flow Logs on
 * the NAT instances, 2026-11-28). The ladder bought nothing a copy needs: the
 * original plays as stored, exactly as it already did for every federated video
 * still waiting in the backlog, and the poster is rendered on demand by
 * `ensureVideoPoster` (a bounded range read of the original).
 *
 * Videos people upload to Oxy are not federated and keep their ladder, and an
 * explicit re-encode (`generateVariants(id, { reencode: true })`) always builds it.
 */
export function skipsVideoLadder(
  file: Pick<FileRecord, 'mime' | 'metadata' | 'purpose' | 'systemOwner'>,
): boolean {
  const family = file.mime.split(';')[0].trim().toLowerCase();
  if (!PROGRESSIVE_VIDEO_TYPES.has(family)) return false;
  if (file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE) return true;
  if (file.systemOwner === '__federation_media_cache__') return true;
  return file.metadata?.source === 'federation';
}
