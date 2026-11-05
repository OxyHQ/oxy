import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/text-field` stub, for the same reason as the
 * button stub: the real field reads Bloom's theme through a relative import no
 * `moduleNameMapper` entry can reach. Renders a DOM `<input>` that forwards the
 * value, the change handler and the props a test asserts on (the secret-input
 * props included), so a screen's behaviour is testable without Bloom's paint.
 */
type InputProps = {
  label?: string;
  value?: string;
  onChangeText?: (value: string) => void;
  onValueChange?: (value: string) => void;
  placeholder?: string | null;
  disabled?: boolean;
  editable?: boolean;
  invalid?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  [key: string]: unknown;
};

export function TextFieldInput({
  label,
  value,
  onChangeText,
  onValueChange,
  placeholder,
  disabled,
  editable,
  invalid,
  accessibilityLabel,
  testID,
  ...rest
}: InputProps): React.ReactElement {
  const passthrough: Record<string, unknown> = {};
  for (const key of [
    'autoCapitalize',
    'autoCorrect',
    'autoComplete',
    'keyboardType',
    'importantForAutofill',
    'textContentType',
    'spellCheck',
    'secureTextEntry',
    'multiline',
  ]) {
    if (key in rest) passthrough[`data-${key.toLowerCase()}`] = String(rest[key]);
  }
  return React.createElement('input', {
    'aria-label': accessibilityLabel ?? label,
    'aria-invalid': invalid ? 'true' : undefined,
    'data-testid': testID,
    value: value ?? '',
    placeholder: placeholder ?? undefined,
    disabled: disabled || editable === false,
    onChange: (event: { target: { value: string } }) => {
      onChangeText?.(event.target.value);
      onValueChange?.(event.target.value);
    },
    ...passthrough,
  });
}

export function TextField({ children }: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement('div', null, children);
}

const passthroughPart = ({ children }: { children?: React.ReactNode }) =>
  React.createElement('span', null, children);
export const TextFieldLabel = passthroughPart;
export const TextFieldHint = passthroughPart;
export const TextFieldSuffix = passthroughPart;
export const TextFieldGhost = passthroughPart;
export function TextFieldIcon(): null {
  return null;
}

/** `@oxy.so/bloom/textarea` maps here too: the same `<input>`, multi-line or not. */
export function Textarea(props: InputProps): React.ReactElement {
  return TextFieldInput(props);
}
