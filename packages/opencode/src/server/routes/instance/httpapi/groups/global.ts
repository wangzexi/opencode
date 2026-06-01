import { Config } from "@/config/config"
import { Project as ConfigProject } from "@/config/projects"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const OpenedOpenPayload = Schema.Struct({ worktree: Schema.String })
const OpenedClosePayload = Schema.Struct({ worktree: Schema.String })
const OpenedMetaPayload = Schema.Struct({
  worktree: Schema.String,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(
    Schema.Struct({
      color: Schema.optional(Schema.String),
      override: Schema.optional(Schema.String),
    }),
  ),
  commands: Schema.optional(
    Schema.Struct({
      start: Schema.optional(Schema.String),
    }),
  ),
})
const OpenedReorderPayload = Schema.Struct({
  projects: Schema.Array(ConfigProject),
})

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const SyncEventSchemas = EventV2.registry
  .values()
  .flatMap((definition) => {
    if (!definition.sync) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.sync.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventV2.registry
      .values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: [HttpApiSchema.NoContent, GlobalUpgradeInput],
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version or latest if not specified.",
        }),
      ),
      HttpApiEndpoint.get("openedList", "/global/project/opened", {
        success: described(Schema.Array(ConfigProject), "List of opened projects"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.project.opened.list",
          summary: "List opened projects",
          description: "Get the list of opened projects with their metadata.",
        }),
      ),
      HttpApiEndpoint.post("openedOpen", "/global/project/opened", {
        payload: OpenedOpenPayload,
        success: described(Schema.Array(ConfigProject), "Updated opened projects list"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.project.opened.open",
          summary: "Open a project",
          description: "Add a project to the opened projects list.",
        }),
      ),
      HttpApiEndpoint.delete("openedClose", "/global/project/opened", {
        payload: OpenedClosePayload,
        success: described(Schema.Array(ConfigProject), "Updated opened projects list"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.project.opened.close",
          summary: "Close a project",
          description: "Remove a project from the opened projects list.",
        }),
      ),
      HttpApiEndpoint.patch("openedMeta", "/global/project/opened", {
        payload: OpenedMetaPayload,
        success: described(Schema.Array(ConfigProject), "Updated project metadata"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.project.opened.meta",
          summary: "Update project metadata",
          description: "Update name, icon, or commands for an opened project.",
        }),
      ),
      HttpApiEndpoint.put("openedReorder", "/global/project/opened", {
        payload: OpenedReorderPayload,
        success: described(Schema.Array(ConfigProject), "Reordered opened projects list"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.project.opened.reorder",
          summary: "Reorder opened projects",
          description: "Replace the entire opened projects list to reflect new ordering.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
