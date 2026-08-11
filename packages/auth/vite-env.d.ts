/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OXY_API_URL: string;
  readonly VITE_OXY_AUTH_URL: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_APPLE_CLIENT_ID: string;
  readonly VITE_GITHUB_CLIENT_ID: string;
  /**
   * The auth app's OWN registered OAuth client id (ApplicationCredential
   * publicKey). The IdP is itself a relying party for the "Sign in with Oxy"
   * (QR) handoff, so it needs a registered Application identity distinct from
   * the per-request `?client_id=` of the RP it is authorizing.
   */
  readonly VITE_OXY_CLIENT_ID: string;
  /**
   * Whether `/authorize` is served by the browser DeviceSession hub (issue #937
   * Phase 5, ADR 0003). Strictly `"1"` enables it; unset — the default, and
   * every build so far — leaves the IdP byte-for-byte as it was. Flipping it is
   * the browser-verification gate; see `lib/hub-client.ts`.
   */
  readonly VITE_OXY_BROWSER_HUB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Minimal ambient type for the lazily-imported `qrcode` package, scoped to the
 * single function the "Sign in with Oxy" QR screen calls. Validated against
 * `qrcode@1.5.x`. Avoids pulling `@types/qrcode` (full Node stream surface).
 */
declare module "qrcode" {
  export interface QRCodeToDataURLOptions {
    margin?: number;
    width?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    color?: { dark?: string; light?: string };
  }
  export function toDataURL(
    text: string,
    options?: QRCodeToDataURLOptions,
  ): Promise<string>;
}
