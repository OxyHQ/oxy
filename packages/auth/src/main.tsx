import { useEffect } from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { BloomThemeProvider } from "@oxy.so/bloom/theme"
import { ConnectionStatusToasts } from "@oxy.so/bloom/connection-status"
import { OxyProvider } from "@oxy.so/services"
import { getBloomThemeCSS } from "@/lib/bloom-css"
import { getApiBaseUrl } from "@/lib/oxy-api-client"
import { OXY_CLIENT_ID } from "@/lib/oxy-client"
import { isBrowserHubEnabled } from "@/lib/hub-client"
import { DocumentLanguage } from "@/lib/i18n/document-language"
import { AuthLayout } from "@/src/pages/layout"
import { LoginPage } from "@/src/pages/login"
import { SignUpPage } from "@/src/pages/signup"
import { AuthorizePage } from "@/src/pages/authorize"
import { HubAuthorizePage } from "@/src/pages/hub-authorize"
import { McpLinkPage } from "@/src/pages/mcp-link"
import { DevicePage } from "@/src/pages/device"
import { ContinuePage } from "@/src/pages/continue"
import { IdentityPage } from "@/src/pages/identity"
import { PrfCheckPage } from "@/src/pages/prf-check"
import "@/app/globals.css"

function ExternalRedirect({ url }: { url: string }) {
    useEffect(() => {
        window.location.replace(url)
    }, [url])
    return null
}

// Inject the Bloom theme's CSS vars before first paint (FOUC prevention);
// `BloomThemeProvider` owns the theme once React mounts.
const styleEl = document.createElement("style")
styleEl.textContent = getBloomThemeCSS()
document.head.appendChild(styleEl)

/**
 * Whether this build serves `/authorize` from the browser hub (issue #937
 * Phase 5, ADR 0003).
 *
 * Read ONCE, here, from the build's own env — one flag for the whole lane. OFF
 * is the default and means `auth.oxy.so` behaves byte-for-byte as it does
 * today: the SDK's per-origin `{deviceId, deviceSecret}`, the normal cold boot,
 * and not one `/hub/*` request. Flipping it ON is the BROWSER-VERIFICATION
 * GATE — it comes out when somebody has actually run Chrome, Safari and
 * Firefox, private windows, and third-party cookies blocked against the lane,
 * never on reasoning.
 */
const BROWSER_HUB_ENABLED = isBrowserHubEnabled(import.meta.env)

/** The one place the flag chooses a page. */
function AuthorizeRoute() {
    return BROWSER_HUB_ENABLED ? <HubAuthorizePage /> : <AuthorizePage />
}

function App() {
    return (
        <BloomThemeProvider mode="system" colorPreset="oxy">
                <ConnectionStatusToasts />
                {/* The IdP is a device-first origin like every other Oxy app: it
                    runs the normal SDK cold boot (restore this origin's device
                    session from its own persisted `{deviceId, deviceSecret}`),
                    enumerates the device directory through `useDeviceSwitcher`, and
                    supplies the OxyAccountDialog + OxyConsentScreen context. It
                    stays a shell OAuth/authorize/consent surface — NOT a Relying
                    Party. The former `coldBoot={false}` IdP exception existed for
                    the SSO bounce the zero-cookie cutover deleted. */}
                <OxyProvider
                    baseURL={getApiBaseUrl()}
                    clientId={OXY_CLIENT_ID}
                    // No product analytics on the origin where people sign in,
                    // consent and recover (ADR 0024 D1): nothing third-party runs
                    // here, and the edge's analytics beacon is blocked by this
                    // origin's CSP (`oxy.pages-headers.json` → `sensitive`).
                    // With the browser hub ON, the durable credential for this
                    // browser profile is the server-side DeviceSession behind
                    // `__Host-oxy-device`, so this origin persists none of its
                    // own. Two durable credentials for one origin is the dual
                    // authority ADR 0003 exists to remove — revoking the hub
                    // while a localStorage secret still mints would make a
                    // sign-out look like it worked. OFF (the default) leaves the
                    // provider byte-for-byte as it was.
                    deviceCredentialStorage={
                        BROWSER_HUB_ENABLED ? "ephemeral" : "persistent"
                    }
                >
                    <DocumentLanguage />
                    <BrowserRouter>
                        <Routes>
                            {/* Auth flow routes */}
                            <Route element={<AuthLayout />}>
                                <Route path="/login" element={<LoginPage />} />
                                <Route path="/signup" element={<SignUpPage />} />
                                <Route path="/authorize" element={<AuthorizeRoute />} />
                                <Route path="/auth/login" element={<LoginPage />} />
                                <Route path="/auth/signup" element={<SignUpPage />} />
                                <Route path="/auth/authorize" element={<AuthorizeRoute />} />
                                {/* Adding another account to an existing MCP
                                    connection. Not an OAuth request: there is no
                                    relying party and no redirect — the person
                                    approves here and returns to their assistant. */}
                                <Route path="/mcp/link" element={<McpLinkPage />} />
                                <Route path="/auth/mcp/link" element={<McpLinkPage />} />
                                {/* Approving a device sign-in (e.g. `codea login`) from a
                                    code the device shows. Also not an OAuth request:
                                    the approval lands server-side and the device,
                                    which kept the secret, finishes by polling. */}
                                <Route path="/device" element={<DevicePage />} />
                                <Route path="/auth/device" element={<DevicePage />} />
                                {/* The web identity carrier (ADR 0027): the popup an
                                    app opens to sign in or create an account with a
                                    passkey, and the person's identity — recovery
                                    phrase, recovery, the move to Commons, deletion. */}
                                <Route path="/continue" element={<ContinuePage />} />
                                <Route path="/identity" element={<IdentityPage />} />
                                <Route path="/identity/move" element={<IdentityPage intent="move" />} />
                                <Route path="/prf-check" element={<PrfCheckPage />} />
                            </Route>

                            {/* Account management lives on accounts.oxy.so — the IdP no longer
                                owns account settings. Permanent redirects to the sole owner. */}
                            <Route path="/settings" element={<ExternalRedirect url="https://accounts.oxy.so/security" />} />
                            <Route path="/settings/sessions" element={<ExternalRedirect url="https://accounts.oxy.so/sessions" />} />

                            <Route path="/" element={<ExternalRedirect url="https://oxy.so" />} />
                            <Route path="*" element={<Navigate to="/login" replace />} />
                        </Routes>
                    </BrowserRouter>
                </OxyProvider>
        </BloomThemeProvider>
    )
}

const rootEl = document.getElementById("root")
if (rootEl) {
    // NOTE: Do NOT wrap <App /> in <React.StrictMode>. On web, react-native-web's
    // Modal (used by Bloom's BottomSheet / bottom-placement Dialog, i.e. the
    // "Sign in with Oxy" sheet) mounts its ModalPortal host during render and
    // removes it in an effect cleanup; StrictMode's dev double-invoke never
    // re-attaches it, so bottom sheets never paint. accounts (Expo) renders
    // without StrictMode for the same reason.
    ReactDOM.createRoot(rootEl).render(<App />)
}
