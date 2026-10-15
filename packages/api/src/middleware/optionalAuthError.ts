/** A presented identity may not become anonymous after a safety refusal or authority failure. */
export class OptionalAuthenticationPolicyError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
  }
}
