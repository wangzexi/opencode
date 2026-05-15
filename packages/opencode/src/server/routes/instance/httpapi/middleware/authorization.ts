import { ServerAuth } from "@/server/auth"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"

const AUTH_TOKEN_QUERY = "auth_token"
const AUTH_TOKEN_COOKIE = "oc_auth_token"
const UNAUTHORIZED = 401
// Use Bearer scheme so browsers don't show a native auth dialog on 401.
// The server still accepts Authorization: Basic credentials from the app.
const WWW_AUTHENTICATE = 'Bearer realm="Secure Area"'

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return yield* effect
    if (!ServerAuth.authorized(credential, config)) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new HttpApiError.Unauthorized({})
    }
    return yield* effect
  })
}

function decodeCredential(input: string) {
  return Encoding.decodeBase64String(input)
    .asEffect()
    .pipe(
      Effect.match({
        onFailure: emptyCredential,
        onSuccess: (header) => {
          const parts = header.split(":")
          if (parts.length !== 2) return emptyCredential()
          return {
            username: parts[0],
            password: Redacted.make(parts[1]),
          }
        },
      }),
    )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  // Fall back to cookie set on a previous authenticated request
  const cookieHeader = request.headers.cookie ?? ""
  const cookieMatch = new RegExp(`(?:^|;\\s*)${AUTH_TOKEN_COOKIE}=([^;]+)`).exec(cookieHeader)
  if (cookieMatch) return decodeCredential(cookieMatch[1])
  return Effect.succeed(emptyCredential())
}

function setCookieHeader(
  response: HttpServerResponse.HttpServerResponse,
  token: string,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.setHeader(
    response,
    "set-cookie",
    `${AUTH_TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
  )
}

// Router middleware for all routes except the SPA catch-all. Requires auth for
// non-public paths and sets a persistent cookie when auth_token is in the URL.
export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        if (hasPtyConnectTicketURL(url)) return yield* effect
        const token = url.searchParams.get(AUTH_TOKEN_QUERY)
        const credential = yield* credentialFromURL(url, request)
        if (!ServerAuth.authorized(credential, config)) {
          return HttpServerResponse.empty({
            status: UNAUTHORIZED,
            headers: { "www-authenticate": WWW_AUTHENTICATE },
          })
        }
        // Auth passed — get the response and attach cookie if token came via URL.
        // Direct header manipulation avoids appendPreResponseHandler which does not
        // fire reliably in the raw router middleware context.
        const response = yield* (effect as unknown as Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>)
        return token ? setCookieHeader(response, token) : response
      })
  }),
)

// Router middleware for the SPA catch-all route (/*). Always serves content so
// the browser can load the app shell at any subpath without a credential prompt.
// API routes have their own auth layer; the SPA handles auth internally once loaded.
// Sets a persistent cookie when a valid auth_token query param is supplied so that
// subsequent SPA navigation (without the query param) remains authenticated.
export const uiRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const token = url.searchParams.get(AUTH_TOKEN_QUERY)
        // Always serve — the SPA handles auth internally via stored credentials.
        const response = yield* (effect as unknown as Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>)
        if (!token) return response
        const credential = yield* credentialFromURL(url, request)
        return ServerAuth.authorized(credential, config) ? setCookieHeader(response, token) : response
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Health endpoint must be public so the SPA can render before credentials
        // are configured — otherwise the user can never reach the credential UI.
        if (new URL(request.url, "http://localhost").pathname === "/global/health") return yield* effect
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)
