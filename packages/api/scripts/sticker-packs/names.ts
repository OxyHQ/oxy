/**
 * How a folder of sticker packs becomes catalogue entries: a pack slug from its
 * folder name, and each sticker's emoji and search keywords from its file name.
 * Shared by `upload-sticker-packs.ts` (through the staff API) and
 * `import-sticker-packs.ts` (inside the API image), so both give a sticker the
 * same emoji.
 */

/**
 * Words in a file name → the emoji they stand for. Matched as substrings of
 * the lower-cased name, first match wins, so the more specific entries come
 * first (`thumbsup` before `up`, `heartbroken` before `heart`).
 */
export const EMOJI_BY_WORD: [string, string][] = [
  ['rollover', '🙃'], ['surprise', '😮'], ['suprise', '😮'],
  ['thumbsup', '👍'], ['thumbs_up', '👍'], ['fistbump', '👊'], ['fist_bump', '👊'],
  ['fingerscrossed', '🤞'], ['peace', '✌️'], ['handsup', '🙌'], ['shrug', '🤷'],
  ['wave', '👋'], ['waving', '👋'], ['hello', '👋'], ['sup', '👋'],
  ['mindblown', '🤯'], ['mind_blown', '🤯'], ['lovestruck', '😍'], ['inlove', '😍'],
  ['loving', '🥰'], ['love', '❤️'], ['heart', '❤️'], ['kiss', '😘'], ['hug', '🤗'],
  ['imissyou', '🥺'], ['missyou', '🥺'], ['grateful', '🙏'],
  ['laugh', '😂'], ['lol', '😂'], ['giggl', '🤭'], ['teeth_smile', '😁'], ['smile', '😊'],
  ['sobbing', '😭'], ['crying', '😭'], ['cry', '😢'], ['sad', '😢'], ['grief', '😢'],
  ['hurting', '😣'], ['defeated', '😞'], ['sombre', '😔'], ['somber', '😔'],
  ['angry', '😠'], ['anger', '😠'], ['mad', '😡'], ['annoyed', '😒'], ['humph', '😤'],
  ['evil', '😈'], ['mischievous', '😈'], ['sneaky', '😏'], ['smug', '😏'], ['smirk', '😏'],
  ['wink', '😉'], ['cheeky', '😜'], ['silly', '😜'], ['zany', '🤪'], ['playful', '😜'],
  ['trolling', '😜'], ['rizz', '😏'], ['wolfish', '😏'],
  ['surprise', '😮'], ['suprise', '😮'], ['gasp', '😮'], ['ohhh', '😮'], ['omg', '😱'],
  ['shocked', '😱'], ['scared', '😱'], ['awe', '😮'], ['speechless', '😶'], ['empty_face', '😶'],
  ['nervous', '😬'], ['anxious', '😰'], ['stressed', '😫'], ['overwhelmed', '😵'],
  ['dizzy', '😵‍💫'], ['dissociating', '😶‍🌫️'], ['awkward', '😬'], ['oops', '😅'],
  ['embarrass', '😳'], ['embarass', '😳'], ['shy', '😊'],
  ['confused', '😕'], ['hmm', '🤔'], ['hm_', '🤔'], ['skeptical', '🤨'], ['suspicious', '🤨'],
  ['sus', '🤨'], ['judgemental', '🧐'], ['condescending', '🧐'], ['eyeroll', '🙄'],
  ['looking', '👀'], ['watching', '👀'], ['focused', '🧐'], ['nope', '🙅'],
  ['tired', '😴'], ['sleepy', '😴'], ['goodnight', '🌙'], ['chilling', '😌'], ['relaxed', '😌'],
  ['contented', '😌'], ['satisfied', '😌'], ['zen', '🧘'], ['cosy', '☕'], ['coffee', '☕'],
  ['siptea', '🍵'], ['bloated', '🤢'], ['hungry', '🤤'], ['hayfever', '🤧'],
  ['cool', '😎'], ['confident', '😎'], ['shining', '✨'], ['thriving', '💅'], ['winning', '🏆'],
  ['celebrat', '🎉'], ['party', '🥳'], ['letsparty', '🥳'], ['yay', '🥳'], ['excited', '🤩'],
  ['delighted', '😄'], ['inspired', '💡'], ['imyourfan', '🤩'],
  ['dance', '💃'], ['vibing', '🎶'], ['fire', '🔥'], ['omw', '🏃'], ['disappear', '🫥'],
  ['hiding', '🫣'], ['fakingit', '🙃'], ['everythingisoki', '🙃'], ['rollover', '🙃'],
  ['red_card', '🟥'], ['laptop', '💻'], ['croak', '🐸'], ['petals', '🌸'], ['squeezer', '🍋'],
  ['cute', '🥰'], ['catchingfeelings', '🥰'],
];

export const DEFAULT_EMOJI = '🙂';

/** The words of a file name, without the export noise authoring tools add. */
export function wordsOf(fileName: string): string[] {
  return fileName
    .replace(/\.json$/i, '')
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 1)
    .filter((word) => !/^(wa|lottie|json|export|opti|optimised|optimising|assemble|pc|vxx|xx|name|packname|stickernumber|stickername)$/i.test(word))
    .filter((word) => !/^v\d*$/i.test(word));
}

/**
 * The part of a file name that names the STICKER, not the pack: exports are
 * usually `<Prefix>_<Pack>_<NN>_<Name>`, and a pack called "Dance to the Beat"
 * would otherwise make every sticker in it 💃.
 */
export function stickerName(fileName: string): string {
  const withoutPrefix = fileName.replace(/^WA_/i, '');
  const numbered = withoutPrefix.match(/^[A-Za-z]+_\d+[a-z]?_(.+)$/);
  return numbered ? numbered[1] : withoutPrefix;
}

export function emojiFor(fileName: string): string {
  const lower = stickerName(fileName).toLowerCase();
  return EMOJI_BY_WORD.find(([word]) => lower.includes(word))?.[1] ?? DEFAULT_EMOJI;
}

export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

/** One pack as the importer reads it. */
export interface StickerManifestPack {
  title: string;
  slug: string;
  stickers: { file: string; emoji: string; keywords: string[] }[];
}

export interface StickerManifest {
  packs: StickerManifestPack[];
}

/** Stickers are added in file-name order, numbers compared as numbers. */
export function stickerFileOrder(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function manifestPack(title: string, files: readonly string[]): StickerManifestPack {
  return {
    title,
    slug: slugify(title),
    stickers: [...files].sort(stickerFileOrder).map((file) => ({ file, emoji: emojiFor(file), keywords: wordsOf(file) })),
  };
}
