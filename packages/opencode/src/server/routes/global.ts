import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Effect } from "effect"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { Bus } from "@/bus"
import { AppRuntime } from "@/effect/app-runtime"
import { AsyncQueue } from "@/util/queue"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import { lazy } from "../../util/lazy"
import { Config } from "@/config/config"
import { ConfigProjects } from "@/config/projects"
import { errors } from "../error"
import { Event as ServerEvent } from "../event"
import { disposeAllInstancesAndEmitGlobalDisposed } from "../global-lifecycle"

const log = Log.create({ service: "server" })

function emitOpenedProjectsUpdated() {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      id: Bus.createID(),
      type: ServerEvent.ProjectOpenedUpdated.type,
      properties: {},
    },
  })
}

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
  return streamSSE(c, async (stream) => {
    const q = new AsyncQueue<string | null>()
    let done = false

    q.push(
      JSON.stringify({
        payload: {
          id: Bus.createID(),
          type: "server.connected",
          properties: {},
        },
      }),
    )

    // Send heartbeat every 10s to prevent stalled proxy streams.
    const heartbeat = setInterval(() => {
      q.push(
        JSON.stringify({
          payload: {
            id: Bus.createID(),
            type: "server.heartbeat",
            properties: {},
          },
        }),
      )
    }, 10_000)

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsub()
      q.push(null)
      log.info("global event disconnected")
    }

    const unsub = subscribe(q)

    stream.onAbort(stop)

    try {
      for await (const data of q) {
        if (data === null) return
        await stream.writeSSE({ data })
      }
    } finally {
      stop()
    }
  })
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: InstallationVersion })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      project: z.string().optional(),
                      workspace: z.string().optional(),
                      payload: z.union([...BusEvent.payloads(), ...SyncEvent.payloads()]),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamEvents(c, (q) => {
          async function handler(event: any) {
            q.push(JSON.stringify(event))
          }
          GlobalBus.on("event", handler)
          return () => GlobalBus.off("event", handler)
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())))
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const config = c.req.valid("json")
        const result = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.updateGlobal(config)))
        if (result.changed) {
          void AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })).catch(
            () => undefined,
          )
        }
        return c.json(result.info)
      },
    )
    .get(
      "/project/opened",
      describeRoute({
        summary: "List opened projects",
        description: "Get the list of opened projects with their metadata.",
        operationId: "global.project.opened.list",
        responses: {
          200: {
            description: "List of opened projects",
            content: {
              "application/json": {
                schema: resolver(z.array(ConfigProjects.Project.zod)),
              },
            },
          },
        },
      }),
      async (c) => {
        const cfg = await AppRuntime.runPromise(Config.Service.use((svc) => svc.getGlobal()))
        return c.json(cfg.projects ?? [])
      },
    )
    .post(
      "/project/opened",
      describeRoute({
        summary: "Open a project",
        description: "Add a project to the opened projects list.",
        operationId: "global.project.opened.open",
        responses: {
          200: {
            description: "Updated opened projects list",
            content: {
              "application/json": {
                schema: resolver(z.array(ConfigProjects.Project.zod)),
              },
            },
          },
        },
      }),
      validator("json", z.object({ worktree: z.string() })),
      async (c) => {
        const input = c.req.valid("json")
        const next = await AppRuntime.runPromise(
          Config.Service.use((svc) =>
            Effect.gen(function* () {
              const cfg = yield* svc.getGlobal()
              const projects = cfg.projects ?? []
              if (projects.some((project) => project.worktree === input.worktree)) return projects
              const next = [{ worktree: input.worktree }, ...projects]
              yield* svc.updateGlobal({ ...cfg, projects: next })
              yield* Effect.sync(emitOpenedProjectsUpdated)
              return next
            }),
          ),
        )
        return c.json(next)
      },
    )
    .delete(
      "/project/opened",
      describeRoute({
        summary: "Close a project",
        description: "Remove a project from the opened projects list.",
        operationId: "global.project.opened.close",
        responses: {
          200: {
            description: "Updated opened projects list",
            content: {
              "application/json": {
                schema: resolver(z.array(ConfigProjects.Project.zod)),
              },
            },
          },
        },
      }),
      validator("json", z.object({ worktree: z.string() })),
      async (c) => {
        const input = c.req.valid("json")
        const next = await AppRuntime.runPromise(
          Config.Service.use((svc) =>
            Effect.gen(function* () {
              const cfg = yield* svc.getGlobal()
              const next = (cfg.projects ?? []).filter((project) => project.worktree !== input.worktree)
              yield* svc.updateGlobal({ ...cfg, projects: next })
              yield* Effect.sync(emitOpenedProjectsUpdated)
              return next
            }),
          ),
        )
        return c.json(next)
      },
    )
    .patch(
      "/project/opened",
      describeRoute({
        summary: "Update project metadata",
        description: "Update name, icon, or commands for an opened project.",
        operationId: "global.project.opened.meta",
        responses: {
          200: {
            description: "Updated project metadata",
            content: {
              "application/json": {
                schema: resolver(z.array(ConfigProjects.Project.zod)),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          worktree: z.string(),
          name: z.string().optional(),
          icon: z
            .object({
              color: z.string().optional(),
              override: z.string().optional(),
              emoji: z.string().optional(),
            })
            .optional(),
          commands: z
            .object({
              start: z.string().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const input = c.req.valid("json")
        const next = await AppRuntime.runPromise(
          Config.Service.use((svc) =>
            Effect.gen(function* () {
              const cfg = yield* svc.getGlobal()
              const projects = cfg.projects ?? []
              const next = projects.map((project) => {
                if (project.worktree !== input.worktree) return project
                return {
                  ...project,
                  ...(input.name !== undefined ? { name: input.name } : {}),
                  ...(input.icon !== undefined ? { icon: { ...project.icon, ...input.icon } } : {}),
                  ...(input.commands !== undefined ? { commands: { ...project.commands, ...input.commands } } : {}),
                }
              })
              yield* svc.updateGlobal({ ...cfg, projects: next })
              yield* Effect.sync(emitOpenedProjectsUpdated)
              return next
            }),
          ),
        )
        return c.json(next)
      },
    )
    .put(
      "/project/opened",
      describeRoute({
        summary: "Reorder opened projects",
        description: "Replace the entire opened projects list to reflect new ordering.",
        operationId: "global.project.opened.reorder",
        responses: {
          200: {
            description: "Reordered opened projects list",
            content: {
              "application/json": {
                schema: resolver(z.array(ConfigProjects.Project.zod)),
              },
            },
          },
        },
      }),
      validator("json", z.object({ projects: z.array(ConfigProjects.Project.zod) })),
      async (c) => {
        const input = c.req.valid("json")
        const next = await AppRuntime.runPromise(
          Config.Service.use((svc) =>
            Effect.gen(function* () {
              const cfg = yield* svc.getGlobal()
              yield* svc.updateGlobal({ ...cfg, projects: input.projects })
              yield* Effect.sync(emitOpenedProjectsUpdated)
              return input.projects
            }),
          ),
        )
        return c.json(next)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed())
        return c.json(true)
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade opencode",
        description: "Upgrade opencode to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        const result = await AppRuntime.runPromise(
          Installation.Service.use((svc) =>
            Effect.gen(function* () {
              const method = yield* svc.method()
              if (method === "unknown") {
                return { success: false as const, status: 400 as const, error: "Unknown installation method" }
              }

              const target = c.req.valid("json").target || (yield* svc.latest(method))
              const result = yield* Effect.catch(
                svc.upgrade(method, target).pipe(Effect.as({ success: true as const, version: target })),
                (err) =>
                  Effect.succeed({
                    success: false as const,
                    status: 500 as const,
                    error: err instanceof Error ? err.message : String(err),
                  }),
              )
              if (!result.success) return result
              return { ...result, status: 200 as const }
            }),
          ),
        )
        if (!result.success) {
          return c.json({ success: false, error: result.error }, result.status)
        }
        const target = result.version
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Installation.Event.Updated.type,
            properties: { version: target },
          },
        })
        return c.json({ success: true, version: target })
      },
    ),
)
