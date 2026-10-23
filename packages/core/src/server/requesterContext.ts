import type { ServiceLane } from '../client/context';

/** One original requester proof, kept transient and isolated per operation. */
export type RequesterProof = (
  | { requesterToken: string; taskId?: never; capabilityTicket?: never }
  | { taskId: string; requesterToken?: never; capabilityTicket?: never }
  | { capabilityTicket: string; requesterToken?: never; taskId?: never }
) & { accountId?: string };

export function bindRequesterLane(original: ServiceLane, proof: RequesterProof): ServiceLane {
  const values = [proof.requesterToken, proof.taskId, proof.capabilityTicket].filter(
    (value) => value !== undefined,
  );
  if (
    values.length !== 1 ||
    !values[0] ||
    values[0].length > 16384 ||
    /\s/.test(values[0]) ||
    (proof.accountId !== undefined && (!proof.accountId || /\s/.test(proof.accountId)))
  )
    throw new Error('One requester proof and an optional exact account ID are required');
  const fixed = {
    requesterToken: proof.requesterToken,
    taskId: proof.taskId,
    capabilityTicket: proof.capabilityTicket,
    actAs: proof.accountId,
  };
  return {
    get available() {
      return original.available;
    },
    request: (method, url, data, options) => {
      const headers = { ...options?.headers };
      for (const key of Object.keys(headers))
        if (
          [
            'x-oxy-user-id',
            'x-oxy-task-id',
            'x-oxy-requester-token',
            'x-oxy-capability-ticket',
          ].includes(key.toLowerCase())
        )
          delete headers[key];
      return original.request(method, url, data, {
        ...options,
        ...fixed,
        headers,
        cache: false,
        deduplicate: false,
        retry: false,
      });
    },
  };
}
