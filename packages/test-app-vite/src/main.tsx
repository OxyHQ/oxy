import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { OxyProvider } from "@oxyhq/services"
import { BloomThemeProvider } from "@oxyhq/bloom/theme"
import { ConnectionStatusToasts } from "@oxyhq/bloom/connection-status"

import "./index.css"
import App from "./App.tsx"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 30,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: "always",
    },
    mutations: {
      retry: 1,
    },
  },
})

const oxyBaseUrl = import.meta.env.VITE_OXY_URL || "https://api.oxy.so"

const rootElement = document.getElementById("root")
if (!rootElement) {
  throw new Error('Root element "#root" not found')
}

// Intentionally NO <StrictMode>: on web, react-native-web's Modal (used by
// Bloom's BottomSheet / bottom-placement Dialog — the account/sign-in sheet on
// narrow viewports) mounts its portal host during render and removes it in an
// effect cleanup; StrictMode's dev double-invoke never re-attaches it, so bottom
// sheets never paint. Console, accounts, and the auth IdP all render without
// StrictMode for the same reason.
createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <BloomThemeProvider mode="system" colorPreset="oxy">
      <ConnectionStatusToasts />
      <OxyProvider baseURL={oxyBaseUrl} queryClient={queryClient}>
        <App />
      </OxyProvider>
    </BloomThemeProvider>
  </QueryClientProvider>
)
