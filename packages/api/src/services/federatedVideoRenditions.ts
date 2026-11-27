import { FEDERATION_MEDIA_CACHE_PURPOSE } from '../constants/federationCache';
import type { FileRecord } from '../types/file.types';

/**
 * Whether a VIDEO's background generation skips the encoded ladder.
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
 * Videos people upload to Oxy are not federated and keep their ladder.
 */
export function skipsVideoLadder(
  file: Pick<FileRecord, 'mime' | 'metadata' | 'purpose' | 'systemOwner'>,
): boolean {
  if (!file.mime.startsWith('video/')) return false;
  if (file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE) return true;
  if (file.systemOwner === '__federation_media_cache__') return true;
  return file.metadata?.source === 'federation';
}
