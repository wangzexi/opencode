import { app } from "electron"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

export type WslConfig = { enabled: boolean }
export type InboundServerConfig = { enabled: boolean; username: string; password: string; port: number | null }

export type HealthCheck = { wait: Promise<void> }

let runtimeInboundServerConfig: InboundServerConfig | null = null
const emptyInboundServerConfig = { enabled: false, username: "", password: "", port: null } satisfies InboundServerConfig

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

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) return process.env.OPENCODE_CONFIG_DIR.trim()
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "opencode")
}

function configFile() {
  const dir = configDir()
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const file = path.join(dir, name)
    if (existsSync(file)) return file
  }
  return path.join(dir, "opencode.jsonc")
}

function sanitizeInboundServerConfig(value: unknown): InboundServerConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : false,
    username: typeof record.username === "string" ? record.username : "",
    password: typeof record.password === "string" ? record.password : "",
    port:
      typeof record.port === "number" && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535
        ? record.port
        : null,
  }
}

function parseConfigText(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {}
  try {
    return JSON.parse(
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    ) as Record<string, unknown>
  } catch {
    return
  }
}

function readInboundServerConfigFromConfigFile() {
  try {
    const value = parseConfigText(readFileSync(configFile(), "utf8"))
    if (!value) return
    return sanitizeInboundServerConfig(value.localServer)
  } catch {
    return
  }
}

function writableInboundServerConfig(config: InboundServerConfig) {
  return {
    enabled: config.enabled,
    ...(config.port !== null ? { port: config.port } : {}),
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
  }
}

function writeInboundServerConfigToConfigFile(config: InboundServerConfig) {
  const file = configFile()
  mkdirSync(path.dirname(file), { recursive: true })
  const next = writableInboundServerConfig(config)
  const current = existsSync(file) ? (parseConfigText(readFileSync(file, "utf8")) ?? {}) : {}
  writeFileSync(file, `${JSON.stringify({ ...current, localServer: next }, null, 2)}\n`)
}

export function getInboundServerConfig(): InboundServerConfig {
  return readInboundServerConfigFromConfigFile() ?? emptyInboundServerConfig
}

export function getInboundRuntimeServerConfig(): InboundServerConfig {
  return runtimeInboundServerConfig ?? emptyInboundServerConfig
}

export function setInboundServerConfig(config: InboundServerConfig) {
  writeInboundServerConfigToConfigFile(config)
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
