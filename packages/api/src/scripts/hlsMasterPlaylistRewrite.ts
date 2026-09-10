/**
 * The pure half of the stored-master repair: rewrite a master playlist's
 * rendition URIs to basenames.
 *
 * Split from the executable script for the reason the sibling `…Plan` modules
 * are: the script connects to Postgres and S3 at module scope, so the transform
 * has to live where a test can import it without doing either.
 */

/** A URI line is any line that is neither blank nor a `#` tag. */
export interface RewrittenMasterPlaylist {
  playlist: string;
  /** How many URI lines were seen — 0 means the master lists no renditions. */
  uriLines: number;
}

/**
 * Replace every URI line with its basename, preserving tags, blank lines,
 * ordering and the trailing newline exactly.
 *
 * A master's URIs resolve against the MASTER's own URL (RFC 8216 §4.3.4.2), and
 * `generateVariantKey` writes the master and every rendition into one directory,
 * so the basename IS the correct reference. Anything already a basename is
 * returned unchanged, which is what makes the repair idempotent.
 *
 * Only existing URI lines are touched: a playlist with none is reported through
 * `uriLines` rather than being "repaired" into itself, because a master with no
 * renditions is a different defect and the caller must be able to see it.
 */
export function rewriteMasterPlaylist(source: string): RewrittenMasterPlaylist {
  let uriLines = 0;
  const playlist = source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) return line;
      uriLines += 1;
      return trimmed.slice(trimmed.lastIndexOf('/') + 1);
    })
    .join('\n');
  return { playlist, uriLines };
}
