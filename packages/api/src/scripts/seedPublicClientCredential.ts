/** New public sign-in identifiers created by the own-app registry.
 * These are not customer API credentials or external OAuth grants. Existing
 * credentials are reused unchanged; their external ceilings are never reset.
 */
export function seedPublicClientCredential(input: {
  applicationId: string;
  publicKey: string;
  createdByUserId: string;
}) {
  return {
    ...input,
    name: 'Production',
    secretHash: null,
    type: 'public' as const,
    environment: 'production' as const,
    scopes: [],
    status: 'active' as const,
  };
}
