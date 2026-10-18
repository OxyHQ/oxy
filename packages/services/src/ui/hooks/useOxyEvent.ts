import { useEffect, useRef } from 'react';

import { useOxy } from '../context/oxyRuntimeContext';

/**
 * Subscribe to a named server-pushed Socket.IO event (e.g. `civic:attested`)
 * for the lifetime of the component. Payloads arrive as `unknown` — callers
 * validate shape. Handler identity may change between renders; the latest one
 * is always invoked.
 */
export function useOxyEvent(event: string, handler: (payload: unknown) => void): void {
  const { sessionClient } = useOxy();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!sessionClient) return;
    return sessionClient.onServerEvent(event, (payload) => {
      handlerRef.current(payload);
    });
  }, [sessionClient, event]);
}
