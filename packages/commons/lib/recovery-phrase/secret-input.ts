import type { TextInputProps } from 'react-native';

/**
 * Props for every input that receives a recovery phrase word or a private key.
 *
 * `autoCorrect={false}` alone still let the platform treat the text as
 * ordinary input: an autofill service (a password manager) could offer to
 * SAVE it, and the keyboard could keep it in its personal dictionary and its
 * synced suggestions. These turn all of that off. `visible-password` is the
 * Android input variation keyboards treat as a password field, so they neither
 * suggest nor learn from it, while the characters stay visible for checking.
 */
export const SECRET_INPUT_PROPS = {
  autoCapitalize: 'none',
  autoCorrect: false,
  spellCheck: false,
  autoComplete: 'off',
  importantForAutofill: 'no',
  textContentType: 'none',
  keyboardType: 'visible-password',
} as const satisfies TextInputProps;
