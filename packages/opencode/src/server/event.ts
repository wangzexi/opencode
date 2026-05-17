import { EventV2 } from "@opencode-ai/core/event"
import { Schema } from "effect"

export const Event = {
  Connected: BusEvent.define("server.connected", Schema.Struct({})),
  Disposed: BusEvent.define("global.disposed", Schema.Struct({})),
  ProjectOpenedUpdated: BusEvent.define("project.opened.updated", Schema.Struct({})),
}

export const InstanceDisposed = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("server.instance.disposed"),
  properties: Schema.Struct({ directory: Schema.String }),
}).annotate({ identifier: "Event.server.instance.disposed" })
