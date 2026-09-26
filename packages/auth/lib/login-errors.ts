/**
 * The failures a previous hop may report to `/login` (`?error=<code>`). Only
 * these codes are shown, each as fixed, localized copy; any other value in the
 * query is ignored, so a crafted link cannot put its own words on the IdP.
 */
export const LOGIN_ERROR_SESSION_EXPIRED = "session_expired"

const LOGIN_ERROR_KEYS: Record<string, string> = {
    [LOGIN_ERROR_SESSION_EXPIRED]: "login.errors.sessionExpired",
}

/** The translation key for a known `?error=` code, or `null` for anything else. */
export function loginErrorKey(code: string | null): string | null {
    return code !== null && Object.hasOwn(LOGIN_ERROR_KEYS, code) ? LOGIN_ERROR_KEYS[code] : null
}
