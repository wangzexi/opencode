import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = "opencode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const INBOUND_ENABLED_KEY = "inboundEnabled"
export const INBOUND_USERNAME_KEY = "inboundUsername"
export const INBOUND_PASSWORD_KEY = "inboundPassword"
export const INBOUND_PORT_KEY = "inboundPort"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
