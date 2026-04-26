import { app } from "electron"
import {
  DEFAULT_SERVER_URL_KEY,
  INBOUND_ENABLED_KEY,
  INBOUND_PASSWORD_KEY,
  INBOUND_PORT_KEY,
  INBOUND_USERNAME_KEY,
  WSL_ENABLED_KEY,
} from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

export type WslConfig = { enabled: boolean }
export type InboundServerConfig = { enabled: boolean; username: string; password: string; port: number | null }

export type HealthCheck = { wait: Promise<void> }

let runtimeInboundServerConfig: InboundServerConfig | null = null

export function setRuntimeInboundServerConfig(config: InboundServerConfig) {
  runtimeInboundServerConfig = config
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export function getInboundServerConfig(): InboundServerConfig {
  const enabled = getStore().get(INBOUND_ENABLED_KEY)
  const username = getStore().get(INBOUND_USERNAME_KEY)
  const password = getStore().get(INBOUND_PASSWORD_KEY)
  const port = getStore().get(INBOUND_PORT_KEY)
  return {
    enabled: typeof enabled === "boolean" ? enabled : false,
    username: typeof username === "string" ? username : "",
    password: typeof password === "string" ? password : "",
    port: typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
  }
}

export function getInboundRuntimeServerConfig(): InboundServerConfig {
  return runtimeInboundServerConfig ?? { enabled: false, username: "opencode", password: "", port: null }
}

export function setInboundServerConfig(config: InboundServerConfig) {
  getStore().set(INBOUND_ENABLED_KEY, config.enabled)
  getStore().set(INBOUND_USERNAME_KEY, config.username)
  getStore().set(INBOUND_PASSWORD_KEY, config.password)
  if (config.port === null) {
    getStore().delete(INBOUND_PORT_KEY)
    return
  }

  getStore().set(INBOUND_PORT_KEY, config.port)
}

export async function spawnLocalServer(hostname: string, port: number, username: string, password: string) {
  prepareServerEnv(username, password)
  const { Log, Server } = await import("virtual:opencode-server")
  await Log.init({ level: "WARN" })
  const listener = await Server.listen({
    port,
    hostname,
    username,
    password,
    cors: ["oc://renderer"],
  })

  const wait = (async () => {
    const url = `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, username, password)) return
      }
    }

    await ready()
  })()

  return { listener, health: { wait } }
}

function prepareServerEnv(username: string, password: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
  const env = {
    ...process.env,
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: app.getPath("userData"),
  }
  Object.assign(process.env, env)
}

export async function checkHealth(url: string, username?: string | null, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (username && password) {
    const auth = Buffer.from(`${username}:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
