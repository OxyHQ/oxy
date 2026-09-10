import { createDeferredProductAnalytics, type ProductAnalytics } from "@oxy.so/services"

const key = import.meta.env.VITE_POSTHOG_KEY?.trim()
const enabled = import.meta.env.VITE_POSTHOG_ENABLED === "true" && Boolean(key)

export const productAnalytics: ProductAnalytics | undefined = enabled && key
    ? createDeferredProductAnalytics(async () => {
        const { default: posthog } = await import("posthog-js")
        posthog.init(key, {
            api_host: "https://eu.i.posthog.com",
            autocapture: false,
            capture_pageview: false,
            capture_pageleave: false,
            capture_exceptions: false,
            disable_session_recording: true,
            disable_surveys: true,
            person_profiles: "identified_only",
        })
        return {
            capture: (event, properties) => posthog.capture(event, properties ? { ...properties } : undefined),
            identify: (distinctId) => posthog.identify(distinctId),
            reset: () => posthog.reset(),
        }
    })
    : undefined
