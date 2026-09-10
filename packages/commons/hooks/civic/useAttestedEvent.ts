import { useOxyEvent } from '@oxy.so/services';

export interface AttestedEventPayload {
  subjectUserId: string;
  byUserId: string;
  recordId: string;
  points: number;
  at: string;
}

/**
 * Fires when the server confirms a real-life attestation for the CURRENT user
 * (`civic:attested` on the user socket room). Strict shape whitelist — a
 * malformed push is dropped, never partially applied. `subjectUserId` is
 * required so callers can scope the confirmation to the identity actually
 * displayed (a device may have more than one signed-in account).
 */
export function useAttestedEvent(onAttested: (payload: AttestedEventPayload) => void): void {
  useOxyEvent('civic:attested', (payload) => {
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    if (
      typeof p.subjectUserId !== 'string' ||
      typeof p.byUserId !== 'string' ||
      typeof p.recordId !== 'string' ||
      typeof p.points !== 'number' ||
      typeof p.at !== 'string'
    ) {
      return;
    }
    onAttested({ subjectUserId: p.subjectUserId, byUserId: p.byUserId, recordId: p.recordId, points: p.points, at: p.at });
  });
}
