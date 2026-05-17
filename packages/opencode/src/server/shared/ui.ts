import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ProxyUtil } from "../proxy-util"

const SERVER_HOSTNAME = (() => {
  try {
    return os.hostname().replace(/\.local$/i, "")
  } catch {
    return ""
  }
})()

function serverDisplayName(request: HttpServerRequest.HttpServerRequest) {
  if (SERVER_HOSTNAME) return SERVER_HOSTNAME
  const host = request.headers["host"] ?? ""
  return host.split(":")[0] ?? ""
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )
}

function rewriteTitle(html: string, name: string) {
  if (!name) return html
  return html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(name)} - OpenCode</title>`)
}

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts")
      .then((module) => module.default as Record<string, string>)
      .catch((error) => {
        console.warn("failed to load embedded web ui", error)
        return null
      })

export const UI_UPSTREAM = new URL(Flag.OPENCODE_DEV_UI_URL ?? "https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI() {
  if (Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI) return Promise.resolve(null)
  return embeddedUIPromise.then((ui) => {
    if (!ui) return null
    if (!ui["index.html"]) return null
    return ui
  })
}

export function embeddedUIFile(file: string) {
  if (path.isAbsolute(file)) return file
  return fileURLToPath(new URL(file, import.meta.url))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array, name: string) {
  const mime = AppFileSystem.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    const rewritten = rewriteTitle(new TextDecoder().decode(body), name)
    headers.set("content-security-policy", cspForHtml(rewritten))
    return HttpServerResponse.raw(new TextEncoder().encode(rewritten), { headers })
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  embeddedWebUI: Record<string, string>,
  name: string,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  const resolved = embeddedUIFile(file)

  return fs.readFile(resolved).pipe(
    Effect.map((body) => embeddedUIResponse(resolved, body, name)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

function serveLocalDirEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  dir: string,
  name: string,
) {
  const filePath = path.join(dir, requestPath === "/" ? "index.html" : requestPath)
  return fs.readFile(filePath).pipe(
    Effect.map((body) => embeddedUIResponse(filePath, body, name)),
    Effect.catchReason("PlatformError", "NotFound", () =>
      fs.readFile(path.join(dir, "index.html")).pipe(
        Effect.map((body) => embeddedUIResponse(path.join(dir, "index.html"), body, name)),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
      ),
    ),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: AppFileSystem.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI())
    const requestPath = new URL(request.url, "http://localhost").pathname
    const name = serverDisplayName(request)

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(requestPath, services.fs, embeddedWebUI, name)

    // Dev mode: serve from local build directory if configured
    if (Flag.OPENCODE_DEV_UI_DIR)
      return yield* serveLocalDirEffect(requestPath, services.fs, Flag.OPENCODE_DEV_UI_DIR, name)

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(requestPath), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = rewriteTitle(yield* response.text, name)
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
