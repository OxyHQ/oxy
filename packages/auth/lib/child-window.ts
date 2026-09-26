/** Whether this window was opened by another window (a popup sign-in). */
export function isChildWindow(): boolean {
    try {
        return !!window.opener && window.opener !== window
    } catch {
        return false
    }
}

/** Close this window if another opened it. Returns whether a close was attempted. */
export function tryCloseChildWindow(): boolean {
    if (isChildWindow()) {
        window.close()
        return true
    }
    return false
}
