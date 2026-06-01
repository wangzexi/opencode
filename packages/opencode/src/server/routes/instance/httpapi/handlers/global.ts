import { Config } from "@/config/config"
import type { Project as ConfigProject } from "@/config/projects"
import { Project } from "@/project/project"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Event as ServerEvent } from "@/server/event"
import { OpenedProjects } from "@/server/shared/opened-projects"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

const log = Log.create({ service: "server" })

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function emitOpenedProjectsUpdated() {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      id: EventV2.ID.create(),
      type: ServerEvent.ProjectOpenedUpdated.type,
      properties: {},
    },
  })
}

function eventResponse() {
  log.info("global event connected")
  const events = Stream.callback<GlobalBusEvent>((queue) => {
    const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
  )

  return HttpServerResponse.stream(
    Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => log.info("global event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const projects = yield* Project.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const before = yield* config.getGlobal()
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) {
        if (JSON.stringify(before) !== JSON.stringify(result.info)) {
          bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
        }
      }
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    const openedList = Effect.fn("GlobalHttpApi.openedList")(function* () {
      return yield* OpenedProjects.list(projects)
    })

    const openedOpen = Effect.fn("GlobalHttpApi.openedOpen")(function* (ctx: { payload: { worktree: string } }) {
      const next = yield* OpenedProjects.open(projects, ctx.payload.worktree)
      yield* Effect.sync(emitOpenedProjectsUpdated)
      return next
    })

    const openedClose = Effect.fn("GlobalHttpApi.openedClose")(function* (ctx: { payload: { worktree: string } }) {
      const next = yield* OpenedProjects.close(projects, ctx.payload.worktree)
      yield* Effect.sync(emitOpenedProjectsUpdated)
      return next
    })

    const openedMeta = Effect.fn("GlobalHttpApi.openedMeta")(function* (ctx: {
      payload: {
        worktree: string
        name?: string
        icon?: { color?: string; override?: string }
        commands?: { start?: string }
      }
    }) {
      const next = yield* OpenedProjects.meta(projects, ctx.payload)
      yield* Effect.sync(emitOpenedProjectsUpdated)
      return next
    })

    const openedReorder = Effect.fn("GlobalHttpApi.openedReorder")(function* (ctx) {
      const next = yield* OpenedProjects.reorder(
        projects,
        (ctx as { payload: { projects: ConfigProject[] } }).payload.projects,
      )
      yield* Effect.sync(emitOpenedProjectsUpdated)
      return next
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
      .handle("openedList", openedList)
      .handle("openedOpen", openedOpen)
      .handle("openedClose", openedClose)
      .handle("openedMeta", openedMeta)
      .handle("openedReorder", openedReorder)
  }),
)
