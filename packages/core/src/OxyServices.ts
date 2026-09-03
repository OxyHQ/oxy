/**
 * OxyServices - Unified client for Oxy API and Oxy Cloud
 *
 * # Usage Examples
 *
 * ## Browser (ESM/TypeScript)
 *
 * ```typescript
 * import { OxyServices } from './core/OxyServices';
 *
 * const oxy = new OxyServices({
 *   baseURL: 'https://api.oxy.so',
 *   cloudURL: 'https://cloud.oxy.so',
 * });
 *
 * // Authenticate and fetch user
 * await oxy.setTokens('ACCESS_TOKEN');
 * const user = await oxy.getCurrentUser();
 *
 * // Upload a file (browser File API)
 * const fileInput = document.querySelector('input[type=file]');
 * const file = fileInput.files[0];
 * await oxy.uploadRawFile(file);
 *
 * // Get a file download URL for <img src>
 * const url = oxy.getFileDownloadUrl('fileId', 'thumb');
 * ```
 *
 * ## Node.js (CommonJS/TypeScript)
 *
 * ```typescript
 * import { OxyServices } from './core/OxyServices';
 * import fs from 'fs';
 *
 * const oxy = new OxyServices({
 *   baseURL: 'https://api.oxy.so',
 *   cloudURL: 'https://cloud.oxy.so',
 * });
 *
 * // Authenticate and fetch user
 * await oxy.setTokens('ACCESS_TOKEN');
 * const user = await oxy.getCurrentUser();
 *
 * // Upload a file (Node.js Buffer)
 * const buffer = fs.readFileSync('myfile.png');
 * const blob = new Blob([buffer]);
 * await oxy.uploadRawFile(blob, { filename: 'myfile.png' });
 *
 * // Get a file download URL
 * const url = oxy.getFileDownloadUrl('fileId');
 * ```
 *
 * ## Configuration
 * - `baseURL`: Oxy API endpoint (e.g., https://api.oxy.so)
 * - `cloudURL`: Oxy Cloud/CDN endpoint (e.g., https://cloud.oxy.so)
 *
 * See method JSDoc for more details and options.
 */
import { OxyServicesBase, type LinkedHttpClient, type OxyConfig } from './OxyServices.base';
import { AssetUrlResolutionError, OxyAuthenticationError, OxyAuthenticationTimeoutError, ServiceAssetMetadataError } from './OxyServices.errors';

// Import mixin composition helper
import { composeOxyServices } from './mixins';

/**
 * OxyServices - Unified client library for interacting with the Oxy API
 * 
 * This class provides all API functionality in one simple, easy-to-use interface.
 * 
 * ## Architecture
 * - **HttpService**: Unified HTTP service handling authentication, caching, deduplication, queuing, and retry
 * - **OxyServices**: Provides high-level API methods
 * 
 * ## Mixin Composition
 * The class is composed using TypeScript mixins for better code organization:
 * - **Base**: Core infrastructure (HTTP client, request management, error handling)
 * - **Auth**: Authentication and session management
 * - **User**: User profiles, follow, notifications
 * - **Privacy**: Blocked and restricted users
 * - **Language**: Language detection and metadata
 * - **Payment**: Payment processing
 * - **Reputation**: Reputation system (Oxy Trust)
 * - **Assets**: File upload and asset management
 * - **Accounts**: Unified account graph (tree, members, roles, bot credentials)
 *   and the applications owned within it (Application = OAuth client)
 * - **Connected apps**: OAuth-consent surface (public app identity, grants)
 * - **Location**: Location-based features
 * - **Analytics**: Analytics tracking
 * - **Devices**: Device management
 * - **Utility**: Utility methods and Express middleware
 * 
 * @example
 * ```typescript
 * const oxy = new OxyServices({
 *   baseURL: 'https://api.oxy.so',
 *   cloudURL: 'https://cloud.oxy.so'
 * });
 * ```
 */
// Compose all mixins into the final OxyServices class. The composed runtime
// class augments OxyServicesBase with every mixin's methods (see mixins/index.ts).
// Statically, TypeScript sees this as a constructor producing OxyServicesBase;
// the additional methods are exposed via interface merging on `OxyServices` below.
const OxyServicesComposed = composeOxyServices();

// Export as a named class to avoid TypeScript issues with anonymous class types.
// We extend the composed constructor directly — its public surface is broadened
// to the full mixin set via the interface declaration that follows.
export class OxyServices extends OxyServicesComposed {
  constructor(config: OxyConfig) {
    super(config);
  }
}

// Type augmentation to expose mixin methods to TypeScript
// This allows proper type checking while avoiding complex mixin type inference.
// Explicit declarations are added for cross-domain auth methods that downstream
// packages (auth-sdk, services) need without casting to `any`.
export interface OxyServices extends InstanceType<ReturnType<typeof composeOxyServices>> {
  createLinkedClient(config: OxyConfig): LinkedHttpClient;

  // Express.js middleware
  auth(options?: {
    debug?: boolean;
    onError?: (error: unknown) => unknown;
    loadUser?: boolean;
    optional?: boolean;
    serviceTokenJwksUrl?: string;
    jwtSecret?: string;
    expectedIssuer?: string;
    expectedAudience?: string;
  }): (req: unknown, res: unknown, next: (err?: unknown) => void) => Promise<void>;

  // Socket.IO middleware
  authSocket(options?: {
    debug?: boolean;
  }): (socket: unknown, next: (err?: Error) => void) => Promise<void>;

  // Service-token-only middleware (delegates to auth() internally)
  serviceAuth(options?: {
    debug?: boolean;
    serviceTokenJwksUrl?: string;
    jwtSecret?: string;
    expectedIssuer?: string;
    expectedAudience?: string;
  }): (req: unknown, res: unknown, next: (err?: unknown) => void) => Promise<void>;

  // Scope enforcement for service-token-protected routes
  requireScope(scope: string): (req: unknown, res: unknown, next: (err?: unknown) => void) => void;

  // Asset management
  assetUpdateVisibility(fileId: string, visibility: 'private' | 'public' | 'unlisted'): Promise<unknown>;
}

// Re-export error classes for convenience
export { AssetUrlResolutionError, OxyAuthenticationError, OxyAuthenticationTimeoutError, ServiceAssetMetadataError };

/**
 * Default Oxy Cloud URL — used when no `cloudURL` is provided to OxyServices.
 */
export const OXY_CLOUD_URL = 'https://cloud.oxy.so';

/**
 * Export the default Oxy API URL (for documentation)
 */
export const OXY_API_URL = (typeof process !== 'undefined' && process.env && process.env.OXY_API_URL) || 'https://api.oxy.so';

/**
 * Pre-configured client instance for easy import
 * Uses OXY_API_URL as baseURL and OXY_CLOUD_URL as cloudURL
 */
export const oxyClient = new OxyServices({ baseURL: OXY_API_URL, cloudURL: OXY_CLOUD_URL });
