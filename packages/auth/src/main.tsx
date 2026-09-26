import { useEffect } from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { BloomThemeProvider } from "@oxy.so/bloom/theme"
import { ConnectionStatusToasts } from "@oxy.so/bloom/connection-status"
import { OxyProvider } from "@oxy.so/services"
import { getBloomThemeCSS } from "@/lib/bloom-css"
import { getApiBaseUrl } from "@/lib/oxy-api-client"
import { OXY_CLIENT_ID } from "@/lib/oxy-client"
import { DocumentLanguage } from "@/lib/i18n/document-language"
import { AuthLayout } from "@/src/pages/layout"
import { LoginPage } from "@/src/pages/login"
import { SignUpPage } from "@/src/pages/signup"
import { AuthorizePage } from "@/src/pages/authorize"
import { McpLinkPage } from "@/src/pages/mcp-link"
import { DevicePage } from "@/src/pages/device"
import { RecoverPage } from "@/src/pages/recover"
import { DeleteAccountPage } from "@/src/pages/delete-account"
import { LinkCommonsPage } from "@/src/pages/link-commons"
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
                >
                    <DocumentLanguage />
                    <BrowserRouter>
                        <Routes>
                            {/* Auth flow routes */}
                            <Route element={<AuthLayout />}>
                                <Route path="/login" element={<LoginPage />} />
                                <Route path="/signup" element={<SignUpPage />} />
                                <Route path="/authorize" element={<AuthorizePage />} />
                                <Route path="/auth/login" element={<LoginPage />} />
                                <Route path="/auth/signup" element={<SignUpPage />} />
                                <Route path="/auth/authorize" element={<AuthorizePage />} />
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
                                {/* A passkey account's own pages (ADR 0029 D3): getting
                                    it back through its recovery email, deleting it
                                    with its passkey, and linking Commons — only here,
                                    where Oxy passkeys are asserted. */}
                                <Route path="/recover" element={<RecoverPage />} />
                                <Route path="/delete-account" element={<DeleteAccountPage />} />
                                <Route path="/link-commons" element={<LinkCommonsPage />} />
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
