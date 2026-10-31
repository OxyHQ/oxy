import { deviceComparisonCode } from '../deviceComparisonCode';

describe('deviceComparisonCode', () => {
  it('prints the first eight characters of the authorize code, upper case, in two groups', () => {
    expect(deviceComparisonCode('ce7fb31f067a617a668827f424f487eb')).toBe('CE7F-B31F');
  });

  it('tells two requests apart by their own codes', () => {
    expect(deviceComparisonCode('7de15b7c98f3d26e7441b62a3baf04e8')).toBe('7DE1-5B7C');
    expect(deviceComparisonCode('7de15b7d98f3d26e7441b62a3baf04e8')).not.toBe(
      deviceComparisonCode('7de15b7c98f3d26e7441b62a3baf04e8'),
    );
  });
});
