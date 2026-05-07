import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { PositiveInt, withStatics } from "@/util/schema"

export const Server = Schema.Struct({
  port: Schema.optional(PositiveInt).annotate({
    description: "Port to listen on",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    description: "Custom domain name for mDNS service (default: opencode.local)",
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
})
  .annotate({ identifier: "ServerConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Server = Schema.Schema.Type<typeof Server>

export const LocalServer = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable remote access for the desktop local server",
  }),
  port: Schema.optional(PositiveInt).annotate({
    description: "Port to listen on for desktop local server remote access",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Username for desktop local server remote access",
  }),
  password: Schema.optional(Schema.String).annotate({
    description: "Password for desktop local server remote access",
  }),
})
  .annotate({ identifier: "LocalServerConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type LocalServer = Schema.Schema.Type<typeof LocalServer>

export * as ConfigServer from "./server"
