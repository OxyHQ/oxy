/**
 * The code a person compares between a device with no keyboard (a TV, a photo
 * frame) and the phone approving its sign-in: `CE7F-B31F`.
 *
 * The device's QR carries the request's full `authorizeCode` (16 random bytes,
 * hex), and that alone is what approves. Its first eight characters are
 * enough to tell "the request on this screen" from any other: the server draws
 * the code at random, so a look-alike request would take about four billion
 * rate-limited attempts, while thirty-two characters were too many for anyone
 * to compare. Both sides (`OxyDeviceSignIn` on the device and the approval
 * page on the phone) derive it here, so they always print the same thing.
 */
const COMPARISON_LENGTH = 8;
const GROUP_LENGTH = 4;

export function deviceComparisonCode(authorizeCode: string): string {
  const head = authorizeCode.slice(0, COMPARISON_LENGTH).toUpperCase();
  return `${head.slice(0, GROUP_LENGTH)}-${head.slice(GROUP_LENGTH)}`;
}
