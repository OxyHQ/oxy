import { getNormalizedUserHandle, type DeviceLinkedSession } from '@oxy.so/core';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The title of one row in "Sessions & devices".
 *
 * `GET /session/device/sessions/:sessionId` lists the sessions that share THIS
 * physical device — one per account signed in here — and sends no
 * `deviceName` at all, although the model declared one. The row interpolated
 * it unconditionally and Android QA read "undefined (This device)"
 * (OxyHQ/oxy#1375 item 11).
 *
 * A name the server does send is used; otherwise the current session is "This
 * device" and any other is named by the account it belongs to, which the
 * response does carry. Never the string "undefined".
 */
export function deviceSessionTitle(
  session: Pick<DeviceLinkedSession, 'deviceName' | 'isCurrent' | 'user'>,
  t: Translate,
): string {
  const thisDevice = t('manageAccount.sessions.thisDevice');
  const deviceName = typeof session.deviceName === 'string' ? session.deviceName.trim() : '';
  if (deviceName) return session.isCurrent ? `${deviceName} (${thisDevice})` : deviceName;
  if (session.isCurrent) return thisDevice;
  const user = session.user;
  const name = user?.name?.displayName?.trim() || (user ? getNormalizedUserHandle(user) : null);
  return name || t('manageAccount.sessions.otherSession');
}
