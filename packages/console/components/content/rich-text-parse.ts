/**
 * Inline markup for translated prose: `` `code` ``, `**bold**` and `[label](/href)`.
 *
 * Translators move words around, so a sentence with a code span or a link in the
 * middle cannot be split into separate keys. One string carries the whole sentence
 * and this parser turns it into runs the renderer styles.
 */
export type RichToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'link'; text: string; href: string };

const PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;

export function parseRichText(source: string): Array<RichToken> {
  const tokens: Array<RichToken> = [];
  let cursor = 0;
  for (const match of source.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: 'text', text: source.slice(cursor, index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ type: 'code', text: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ type: 'bold', text: match[2] });
    } else if (match[3] !== undefined && match[4] !== undefined) {
      tokens.push({ type: 'link', text: match[3], href: match[4] });
    }
    cursor = index + match[0].length;
  }
  if (cursor < source.length) {
    tokens.push({ type: 'text', text: source.slice(cursor) });
  }
  return tokens;
}
