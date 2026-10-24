import { oxyAccountIdSchema, usageQuantitySchema, unitPriceSchema } from '../index';
import { z } from '@oxy.so/zod4';
import {
  utf16MinLength,
  utf16MaxLength,
  utf16Length,
  isoDateTime,
  urlCheck,
} from '../stringChecks';
import { integerCheck, safeNumberCheck } from '../numberChecks';

it('retains UTF-16 bounds for astral characters and combining marks', () => {
  expect(z.string().check(utf16MinLength(2)).parse('😀')).toBe('😀');
  expect(z.string().check(utf16MaxLength(1)).safeParse('😀').success).toBe(false);
  expect(z.string().check(utf16Length(2)).parse('😀')).toBe('😀');
  expect(z.string().check(utf16Length(2)).parse('e\u0301')).toBe('e\u0301');
  expect(z.string().check(utf16MinLength(2)).safeParse('a').success).toBe(false);
});

it.each(['2024-02-29T12:30Z', '2024-02-29T12:30:45Z', '2024-02-29T12:30:45.123Z'])(
  'retains minute, second and fractional timestamp %s',
  (value) => {
    expect(z.string().check(isoDateTime()).parse(value)).toBe(value);
  },
);

it('keeps timestamp precision, calendar and zone controls explicit', () => {
  expect(isoDateTime().safeParse('2025-02-29T12:30Z').success).toBe(false);
  expect(isoDateTime().safeParse('2024-02-29T12:30+0100').success).toBe(false);
  expect(isoDateTime({ offset: true }).parse('2024-02-29T12:30+0100')).toBe(
    '2024-02-29T12:30+0100',
  );
  expect(isoDateTime({ local: true }).parse('2024-02-29T12:30')).toBe('2024-02-29T12:30');
  expect(isoDateTime({ precision: 3 }).safeParse('2024-02-29T12:30Z').success).toBe(false);
  expect(isoDateTime({ precision: 3 }).parse('2024-02-29T12:30:45.123Z')).toBe(
    '2024-02-29T12:30:45.123Z',
  );
});

it('validates URLs without rewriting the stored value', () => {
  const value = ' https://oxy.so/path ';
  expect(z.string().check(urlCheck()).parse(value)).toBe(value);
  expect(z.string().check(urlCheck()).safeParse('not a URL').success).toBe(false);
});

it('retains separate integer and safe bounds', () => {
  expect(
    z
      .number()
      .check(integerCheck())
      .parse(2 ** 60),
  ).toBe(2 ** 60);
  expect(z.number().check(integerCheck()).safeParse(1.5).success).toBe(false);
  expect(z.number().check(safeNumberCheck()).parse(1.5)).toBe(1.5);
  expect(
    z
      .number()
      .check(integerCheck(), safeNumberCheck())
      .safeParse(2 ** 60).success,
  ).toBe(false);
});

it('retains bounds for consumers using the standard JSON Schema generator', () => {
  const account = z.toJSONSchema(oxyAccountIdSchema);
  expect(account).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
  const usage = z.toJSONSchema(usageQuantitySchema);
  expect(usage.properties?.quantity).toMatchObject({
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  const price = z.toJSONSchema(unitPriceSchema);
  expect(price.properties?.per).toMatchObject({
    type: 'integer',
    exclusiveMinimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  expect(z.toJSONSchema(z.string().check(utf16Length(2)))).toMatchObject({
    minLength: 2,
    maxLength: 2,
  });
  const integer = z.toJSONSchema(z.number().check(integerCheck()));
  expect(integer.type).toBe('integer');
  expect(integer.minimum).toBeUndefined();
  expect(integer.maximum).toBeUndefined();
});
