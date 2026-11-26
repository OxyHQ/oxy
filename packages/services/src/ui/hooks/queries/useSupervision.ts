import { useEffect } from 'react';
import { environment, skip } from '@oxy.so/bloom-data';
import { SUPERVISION_CHANGED_EVENT } from '@oxy.so/contracts/client';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useAnswer } from '../../data/answer';
import { supervisionState } from '../../data/supervision';
import { useOxyEvent } from '../useOxyEvent';

/**
 * The signed-in personal account's supervision (parental-control) state.
 *
 * Policy: the SDK keeps the session's supervision state always current — it is
 * read when the session is established, read again when the app returns to
 * the foreground, and read again when the session socket signals
 * `supervision_changed` (`SupervisionStateObserver`, mounted by `OxyProvider`).
 * Screens read what is held without waiting for the network: no reader forces
 * its own read on mount. `value` is undefined only while the session's first
 * read is pending, when the read is skipped (signed out, or not a personal
 * account) and after a failed read.
 *
 * Advisory UI state only. The server keeps enforcing supervision on every
 * content request; never treat this value as authorization.
 */
export function useSupervision() {
  const { oxyServices, user, canUsePrivateApi, activeSessionId } = useOxy();
  const view = useAnswer(
    supervisionState,
    ...(canUsePrivateApi && activeSessionId && user?.kind === 'personal'
      ? ([oxyServices, user.id, activeSessionId] as [typeof oxyServices, string, string])
      : [skip]),
  );
  return view.status === 'error' ? { ...view, value: undefined } : view;
}

/**
 * Keeps the session's supervision state current for every `useSupervision()`
 * reader: it observes the state, so it is read once the session is
 * established; it reads it again on each return to the foreground and when
 * the `supervision_changed` socket signal arrives. Rendered once by
 * `OxyProvider`.
 */
export function SupervisionStateObserver() {
  const { refresh } = useSupervision();
  useOxyEvent(SUPERVISION_CHANGED_EVENT, () => {
    void refresh();
  });
  useEffect(
    () =>
      environment.subscribe((event) => {
        if (event === 'focus') void refresh();
      }),
    [refresh],
  );
  return null;
}
