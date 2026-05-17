import { Effect, Schema } from "effect"
import { Schedule } from "@/session/schedule"
import * as Tool from "./tool"

const DESCRIPTION = `Manage recurring scheduled tasks attached to the current session.

A scheduled task injects a message into this session at a cron-defined cadence. When the cron fires, the message is sent to the session as if the user typed it, and the assistant responds. If the session is currently busy when a fire is due, that tick is skipped (not queued).

Actions:
- create — Add a new scheduled task. Requires "expression" (5-field cron) and "message". Returns the new id and the next planned run.
- delete — Remove a scheduled task. Requires "id" (from create or list).
- list   — Return all scheduled tasks for this session.

Cron expressions are interpreted in the server's local timezone. Use standard 5-field syntax — do NOT pass natural language ("every 10 minutes"); convert to e.g. "*/10 * * * *" yourself.

Examples:
  schedule({ action: "create", expression: "*/10 * * * *", message: "Check the build queue" })
  schedule({ action: "create", expression: "0 9 * * *", message: "Generate the daily summary" })
  schedule({ action: "list" })
  schedule({ action: "delete", id: "sch_..." })

Minimum interval is 60 seconds. Maximum 10 schedules per session.`

const CreateAction = Schema.Struct({
  action: Schema.Literal("create").annotate({ description: "Create a new scheduled task." }),
  expression: Schema.String.annotate({
    description: "Standard 5-field cron expression. Example: '*/10 * * * *'. Minimum interval 60s.",
  }),
  message: Schema.String.annotate({
    description: "Message content to inject into the session when the cron fires.",
  }),
})

const DeleteAction = Schema.Struct({
  action: Schema.Literal("delete").annotate({ description: "Delete an existing scheduled task by id." }),
  id: Schema.String.annotate({ description: "Schedule id from create or list." }),
})

const ListAction = Schema.Struct({
  action: Schema.Literal("list").annotate({
    description: "List all scheduled tasks for this session.",
  }),
})

export const Parameters = Schema.Union([CreateAction, DeleteAction, ListAction]).annotate({
  discriminator: "action",
})

type Metadata = {
  action?: "create" | "delete" | "list"
  scheduleID?: string
  count?: number
}

export const ScheduleTool = Tool.define<typeof Parameters, Metadata, Schedule.Service>(
  "schedule",
  Effect.gen(function* () {
    const schedule = yield* Schedule.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          switch (params.action) {
            case "create": {
              const expression = params.expression.trim()
              return yield* schedule.create({ sessionID: ctx.sessionID, expression, message: params.message }).pipe(
                Effect.map((info) => ({
                  title: `Scheduled: ${expression}`,
                  output: JSON.stringify(
                    {
                      id: info.id,
                      expression: info.expression,
                      message: info.message,
                      nextRun: info.nextRun ? new Date(info.nextRun).toISOString() : null,
                    },
                    null,
                    2,
                  ),
                  metadata: { action: "create", scheduleID: info.id } satisfies Metadata,
                })),
                Effect.catchTag("ScheduleInvalidExpression", (e) =>
                  Effect.succeed({
                    title: "Invalid cron expression",
                    output: `Invalid cron expression "${e.expression}": ${e.reason}. Use a standard 5-field cron expression like "*/10 * * * *" (every 10 minutes) or "0 9 * * *" (daily at 9 AM). Do not pass natural language.`,
                    metadata: { action: "create" } satisfies Metadata,
                  }),
                ),
                Effect.catchTag("ScheduleIntervalTooShort", (e) =>
                  Effect.succeed({
                    title: "Interval too short",
                    output: `Cron expression "${e.expression}" fires every ${Math.round(e.intervalMs / 1000)} seconds. Minimum is 60 seconds. Pick a longer cadence.`,
                    metadata: { action: "create" } satisfies Metadata,
                  }),
                ),
                Effect.catchTag("ScheduleLimitExceeded", (e) =>
                  Effect.succeed({
                    title: "Too many schedules",
                    output: `This session already has ${e.limit} scheduled tasks (the maximum). Delete one with schedule({action:"delete",id:"..."}) before adding another.`,
                    metadata: { action: "create" } satisfies Metadata,
                  }),
                ),
              )
            }
            case "delete": {
              return yield* schedule.delete(params.id as Schedule.ID).pipe(
                Effect.map(() => ({
                  title: "Schedule deleted",
                  output: `Deleted schedule ${params.id}.`,
                  metadata: { action: "delete", scheduleID: params.id } satisfies Metadata,
                })),
                Effect.catchTag("ScheduleNotFound", (e) =>
                  Effect.succeed({
                    title: "Schedule not found",
                    output: `No schedule with id "${e.scheduleID}". Use schedule({action:"list"}) to see current ids.`,
                    metadata: { action: "delete" } satisfies Metadata,
                  }),
                ),
              )
            }
            case "list": {
              const items = yield* schedule.list(ctx.sessionID)
              const payload = items.map((info) => ({
                id: info.id,
                expression: info.expression,
                message: info.message,
                nextRun: info.nextRun ? new Date(info.nextRun).toISOString() : null,
                lastRanAt: info.lastRanAt ? new Date(info.lastRanAt).toISOString() : null,
                lastRunStatus: info.lastRunStatus,
              }))
              return {
                title: items.length === 0 ? "No schedules" : `${items.length} schedule${items.length === 1 ? "" : "s"}`,
                output: JSON.stringify(payload, null, 2),
                metadata: { action: "list", count: items.length } satisfies Metadata,
              }
            }
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
