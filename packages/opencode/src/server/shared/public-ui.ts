// Static UI shell and assets the browser fetches before app-managed credentials
// are available. API routes stay protected; the loaded app supplies credentials
// from its server connection config.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/",
  "/index.html",
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET" && method !== "HEAD") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  if (pathname.startsWith("/assets/")) return true
  if (pathname.startsWith("/favicon")) return true
  if (pathname.startsWith("/apple-touch-icon")) return true
  if (pathname.startsWith("/social-share.")) return true
  return false
}
