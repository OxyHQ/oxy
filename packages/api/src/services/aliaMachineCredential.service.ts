import {
  OXY_ALIA_MACHINE_SCOPES,
  OXY_ALIA_RESOURCE_APPLICATION_ID,
  type AliaMachineCredentialIntrospection,
} from '@oxy.so/core/server';
import {
  resolveMachineCredential,
  type MachineCredentialResolution,
} from '../middleware/machineCredential';

/** Narrow resource contract, not the general service-access grant model (#874). */
export async function introspectAliaMachineCredential(
  verifierApplicationId: string,
  token: string,
  resolve: (token: string) => Promise<MachineCredentialResolution> = resolveMachineCredential,
): Promise<AliaMachineCredentialIntrospection> {
  // Authenticate the resource server first. A different trusted app cannot use
  // this endpoint as a machine-key oracle or choose a different audience.
  if (verifierApplicationId !== OXY_ALIA_RESOURCE_APPLICATION_ID) return { active: false };
  const result = await resolve(token);
  if (
    !result.ok ||
    !OXY_ALIA_MACHINE_SCOPES.every((scope) => result.principal.scopes.includes(scope))
  ) {
    return { active: false };
  }
  const p = result.principal;
  return {
    active: true,
    principal: {
      kind: 'machine',
      audience: OXY_ALIA_RESOURCE_APPLICATION_ID,
      applicationId: p.applicationId,
      credentialId: p.credentialId,
      ownerAccountId: p.ownerAccountId,
      environment: p.environment,
      // Strip unrelated authority: this receipt serves only an app-only Alia
      // chat turn and its Oxy inference. No user, service tier or grants.
      scopes: ['alia:chat', 'inference:invoke'],
    },
  };
}
