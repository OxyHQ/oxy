/**
 * Turn a thrown WebAuthn passkey ceremony error into a friendly, user-facing
 * message for the auth (IdP) forms.
 *
 * The passkey handlers call the SDK's `signInWithPasskey`,
 * which run a `navigator.credentials` ceremony through `@simplewebauthn/browser`.
 * When the user dismisses the browser's system prompt (or it times out) the
 * ceremony rejects with a `NotAllowedError` / `AbortError` DOMException — often
 * re-wrapped by `@simplewebauthn/browser` as a `WebAuthnError` carrying the
 * original as its `cause`. Those raw messages are noisy and alarming ("The
 * operation either timed out or was not allowed…"), so we detect the
 * cancellation shape anywhere in the cause chain and return a calm message
 * instead of crashing or leaking the DOMException text.
 */

/** Friendly copy shown when the user dismisses / cancels the browser prompt. */
export const PASSKEY_CANCELLED_MESSAGE =
    "Passkey prompt dismissed. Try again when you're ready."

/** Generic fallback when a ceremony fails for a non-cancellation reason. */
const PASSKEY_GENERIC_FAILURE = "Couldn't complete the passkey. Please try again."

/**
 * Walk an error's `cause` chain (bounded) looking for the DOMException `name`
 * WebAuthn raises on a user-dismissed / aborted prompt. `@simplewebauthn/browser`
 * wraps the original DOMException as `cause`, so the top-level error is a
 * `WebAuthnError` while the meaningful `name` lives one level down.
 */
function isCancellation(error: unknown): boolean {
    let current: unknown = error
    for (let depth = 0; depth < 5 && current; depth += 1) {
        if (current instanceof Error) {
            if (current.name === "NotAllowedError" || current.name === "AbortError") {
                return true
            }
            // `@simplewebauthn/browser` sets a stable `code` for an aborted ceremony.
            const code = (current as { code?: unknown }).code
            if (code === "ERROR_CEREMONY_ABORTED") {
                return true
            }
            current = (current as { cause?: unknown }).cause
        } else {
            break
        }
    }
    return false
}

/**
 * Resolve a passkey ceremony error to a message suitable for inline display.
 * Cancellations get the calm {@link PASSKEY_CANCELLED_MESSAGE}; anything else
 * falls back to the error's own message, then a generic failure string.
 */
export function describePasskeyError(error: unknown): string {
    if (isCancellation(error)) {
        return PASSKEY_CANCELLED_MESSAGE
    }
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message
    }
    return PASSKEY_GENERIC_FAILURE
}
