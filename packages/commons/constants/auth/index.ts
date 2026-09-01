/**
 * Authentication flow constants
 */

/**
 * Delays and timeouts
 */
export const STORE_UPDATE_DELAY_MS = 100;
export const USERNAME_DEBOUNCE_MS = 500;
export const CREATING_PROGRESS_INTERVAL_MS = 500;
export const CREATING_FINAL_DELAY_MS = 500;

/*
 * Username validation rules used to live here — a third copy of the policy
 * (`^[a-z0-9]+$/i`, minimum 4) that agreed with neither the server nor the SDK.
 * Its minimum would have refused `oxy`, which is the platform owner's own
 * organization. The rule, its length bounds and its message now come from
 * `@oxyhq/contracts` (`usernameSchema`, `USERNAME_MIN_LENGTH`,
 * `USERNAME_INVALID_MESSAGE`), which is what the API enforces.
 */

/**
 * Word lists for generating creative usernames
 */
export const USERNAME_ADJECTIVES = [
  'swift', 'bright', 'calm', 'bold', 'keen', 'wise', 'cool', 'sharp', 'quick', 'brave',
  'clear', 'deep', 'fast', 'firm', 'fresh', 'grand', 'great', 'huge', 'kind', 'light',
  'lucky', 'mighty', 'neat', 'noble', 'proud', 'pure', 'rapid', 'rare', 'rich', 'smooth',
  'solid', 'sound', 'stark', 'steep', 'still', 'stout', 'swift', 'tall', 'tough', 'vast',
  'wild', 'young', 'zesty', 'zen', 'zany', 'zest', 'zap', 'zoom', 'zestful', 'zippy'
];

export const USERNAME_NOUNS = [
  'fox', 'wolf', 'eagle', 'hawk', 'lion', 'tiger', 'bear', 'deer', 'bird', 'fish',
  'star', 'moon', 'sun', 'cloud', 'wave', 'rock', 'tree', 'leaf', 'storm', 'wind',
  'fire', 'ice', 'snow', 'rain', 'mist', 'fog', 'dew', 'frost', 'thunder', 'lightning',
  'river', 'lake', 'ocean', 'hill', 'peak', 'valley', 'cave', 'cliff', 'beach', 'shore',
  'path', 'trail', 'road', 'bridge', 'gate', 'door', 'wall', 'tower', 'fort', 'castle'
];

/**
 * Username generation constants
 */
export const USERNAME_NUM_SUFFIX_MIN = 100;
export const USERNAME_NUM_SUFFIX_MAX = 999;
export const USERNAME_FALLBACK_MIN = 1000;
export const USERNAME_FALLBACK_MAX = 9999;

/**
 * Recovery phrase constants
 */
export const RECOVERY_PHRASE_LENGTH = 12;
export const RECOVERY_PHRASE_24_LENGTH = 24;

/**
 * Where the web sign-in screen points users who don't yet have an account.
 * Identity creation is native-only, so this links to the place that explains
 * how to get the app and create an Oxy identity. Overridable per deployment.
 */
export const CREATE_ACCOUNT_HELP_URL =
  process.env.EXPO_PUBLIC_CREATE_ACCOUNT_URL ?? 'https://oxy.so/download';

