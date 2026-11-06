import { postalAddressInputSchema, postalAddressUpdateSchema } from '../postalAddresses';
const address = {
  recipientName: '山田 太郎',
  line1: '千代田1',
  city: '東京',
  postalCode: '100-0001',
  country: 'JP',
};
describe('private postal addresses', () => {
  it('accepts international names and countries without postal codes', () => {
    expect(postalAddressInputSchema.parse(address)).toEqual(address);
    expect(
      postalAddressInputSchema.safeParse({ ...address, country: 'IE', postalCode: '' }).success,
    ).toBe(true);
  });
  it('refuses ownership injection and controls, without interpreting a public profile', () => {
    expect(postalAddressInputSchema.safeParse({ ...address, userId: 'other' }).success).toBe(false);
    expect(postalAddressInputSchema.safeParse({ ...address, line1: 'road\nforged' }).success).toBe(
      false,
    );
    expect(
      postalAddressInputSchema.safeParse({ ...address, recipientName: '\u202ehidden' }).success,
    ).toBe(false);
    expect(postalAddressUpdateSchema.safeParse({}).success).toBe(false);
  });
});

it('allows explicit removal of optional private fields only', () => {
  expect(
    postalAddressUpdateSchema.parse({ phone: null, line2: null, region: null, label: null }),
  ).toEqual({ phone: null, line2: null, region: null, label: null });
  expect(postalAddressUpdateSchema.safeParse({ recipientName: null }).success).toBe(false);
});
