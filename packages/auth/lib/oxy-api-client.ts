const PRODUCTION_API_URL = "https://api.oxy.so"
const LOCAL_API_URL = "http://localhost:4100"

export function getApiBaseUrl(): string {
  const envUrl =
    import.meta.env.VITE_OXY_API_URL || import.meta.env.VITE_OXY_AUTH_URL
  if (envUrl) return envUrl

  if (import.meta.env.PROD) return PRODUCTION_API_URL
  return LOCAL_API_URL
}

/**
 * Build a streaming avatar URL from a file ID.
 */
export function getAvatarUrl(fileId: string): string {
  const base = getApiBaseUrl()
  const params = new URLSearchParams()
  params.set("variant", "thumb")
  params.set("fallback", "placeholderVisible")
  return `${base}/assets/${encodeURIComponent(fileId)}/stream?${params.toString()}`
}

export function buildRelativeUrl(
  pathname: string,
  params: Record<string, string | undefined>
): string {
  const url = new URL(pathname, "http://localhost")
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value)
    }
  }
  return `${url.pathname}${url.search}`
}

export function getAuthBaseUrl(): string {
  const envUrl =
    import.meta.env.VITE_OXY_AUTH_URL || import.meta.env.VITE_OXY_API_URL
  const defaultUrl = import.meta.env.PROD ? PRODUCTION_API_URL : LOCAL_API_URL
  const baseUrl = (envUrl || defaultUrl).replace(/\/$/, "")

  if (baseUrl.endsWith("/auth")) {
    return baseUrl
  }

  return `${baseUrl}/auth`
}

export function buildAuthUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return `${getAuthBaseUrl()}${normalizedPath}`
}

export function buildApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return `${getApiBaseUrl()}${normalizedPath}`
}
