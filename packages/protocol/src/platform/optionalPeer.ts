/**
 * Actionable error for a missing optional React Native peer.
 *
 * Shared by the React Native platform variants (`crypto.native.ts`,
 * `random.native.ts`). It carries the underlying Metro resolution message so
 * the failure is never silent: the variants' `try { require(...) } catch` only
 * defers the report to the point where the capability is actually used.
 */
export function missingOptionalPeerError(
  packageName: string,
  capability: string,
  cause: unknown,
): Error {
  const sentences = [
    `[oxy.protocol.crypto] '${packageName}' is not installed, so ${capability} is unavailable in this app.`,
    'It is an optional peer dependency of @oxy.so/protocol that the React Native runtime needs —',
    `install it with \`npx expo install ${packageName}\`.`,
  ];
  if (cause instanceof Error) {
    sentences.push(`Underlying error: ${cause.message}`);
  }
  return new Error(sentences.join(' '));
}
