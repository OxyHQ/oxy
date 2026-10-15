import { jwtDecode } from 'jwt-decode';
import { serviceTokenScopesSchema } from '@oxy.so/contracts';
/** Check the trusted mint response, never authenticate a caller from decoded claims. */
export function assertRequestedServiceScopes(token: string, requested?: string[]): void {
  if (!requested) return;
  const granted = serviceTokenScopesSchema.parse(jwtDecode<{ scopes?: unknown }>(token).scopes);
  if (
    granted.length !== requested.length ||
    granted.some((scope, index) => scope !== requested[index])
  )
    throw new Error('Service token mint did not honor the exact requested scopes');
}
