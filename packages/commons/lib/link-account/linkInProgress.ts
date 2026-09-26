/**
 * Whether this phone is linking its fresh key to a web account right now
 * (ADR 0029 D3). While it is, nothing may publish that key as a NEW account:
 * the reconnect sync would `register` it, and the link would then find the
 * key taken. Module state, not persisted — a link does not outlive the app.
 */
let linking = false;

export function setLinkInProgress(value: boolean): void {
  linking = value;
}

export function isLinkInProgress(): boolean {
  return linking;
}
