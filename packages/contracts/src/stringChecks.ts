import { z } from 'zod';

/**
 * Oxy text limits count UTF-16 units. Each factory owns its check and retains
 * native metadata for standard JSON Schema and OpenAPI consumers.
 */
function stringLengthCheck(
  kind: 'min' | 'max' | 'length',
  value: number,
  message?: string | { message?: string },
) {
  const check =
    kind === 'min'
      ? z.minLength(value, message)
      : kind === 'max'
        ? z.maxLength(value, message)
        : z.length(value, message);
  check._zod.check = (context) => {
    const length = context.value.length;
    const tooSmall = kind !== 'max' && length < value;
    const tooBig = kind !== 'min' && length > value;
    if (!tooSmall && !tooBig) return;
    context.issues.push({
      origin: 'string',
      ...(tooSmall
        ? { code: 'too_small' as const, minimum: value }
        : { code: 'too_big' as const, maximum: value }),
      inclusive: true,
      ...(kind === 'length' ? { exact: true } : {}),
      input: context.value,
      inst: check,
      continue: true,
    });
  };
  return check;
}

export function utf16MinLength(minimum: number, message?: string | { message?: string }) {
  return stringLengthCheck('min', minimum, message);
}
export function utf16MaxLength(maximum: number, message?: string | { message?: string }) {
  return stringLengthCheck('max', maximum, message);
}
export function utf16Length(length: number, message?: string | { message?: string }) {
  return stringLengthCheck('length', length, message);
}

/** Oxy timestamps retain optional seconds, fractional precision and existing offset syntax. */
export function isoDateTime(options: string | z.core.$ZodISODateTimeParams = {}) {
  const params = typeof options === 'string' ? { message: options } : options;
  const precision = params.precision;
  const date = z.regexes.date.source.slice(1, -1);
  const fraction = precision ? `\\.\\d{${precision}}` : precision == null ? '(\\.\\d+)?' : '';
  const seconds = `(:[0-5]\\d${fraction})${precision ? '+' : '?'}`;
  const zone = `${params.local ? 'Z?' : 'Z'}${params.offset ? '|[+-]\\d{2}:?\\d{2}' : ''}`;
  const expression = new RegExp(`^${date}T([01]\\d|2[0-3]):[0-5]\\d${seconds}(${zone})$`);
  return z.stringFormat('datetime', expression, params);
}

/** Validate a URL without normalizing the value returned by the API contract. */
export function urlCheck(message?: string | { message?: string }) {
  return z.stringFormat(
    'url',
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    message,
  );
}
