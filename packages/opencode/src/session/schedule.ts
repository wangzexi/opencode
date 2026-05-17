import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Database } from "@/storage/db"
import * as Log from "@opencode-ai/core/util/log"
import { Cron } from "croner"
import { eq, sql as drizzleSql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionID } from "./schema"
import { ScheduleRunTable, ScheduleTable } from "./schedule.sql"

const log = Log.create({ service: "schedule" })

export const MAX_PER_SESSION = 10
export const MIN_INTERVAL_MS = 60_000

export const ID = Schema.String.pipe(Schema.brand("ScheduleID"))
export type ID = Schema.Schema.Type<typeof ID>

export type RunStatus = "ran" | "skipped"
export const RunStatusSchema = Schema.Literals(["ran", "skipped"])

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  expression: Schema.String,
  message: Schema.String,
  createdAt: Schema.Number,
  lastRanAt: Schema.NullOr(Schema.Number),
  lastRunStatus: Schema.NullOr(RunStatusSchema),
  nextRun: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Schedule" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Created: BusEvent.define("schedule.created", Schema.Struct({ scheduleID: ID, sessionID: SessionID })),
  Deleted: BusEvent.define("schedule.deleted", Schema.Struct({ scheduleID: ID, sessionID: SessionID })),
  Ran: BusEvent.define(
    "schedule.ran",
    Schema.Struct({
      scheduleID: ID,
      sessionID: SessionID,
      status: RunStatusSchema,
      ranAt: Schema.Number,
    }),
  ),
  /**
   * Emitted on every cron tick. The downstream runner is responsible for
   * deciding whether to actually inject a message (busy check) and for
   * calling Schedule.recordRun afterwards.
   */
  Triggered: BusEvent.define(
    "schedule.triggered",
    Schema.Struct({
      scheduleID: ID,
      sessionID: SessionID,
      message: Schema.String,
    }),
  ),
}

export class InvalidExpression extends Schema.TaggedErrorClass<InvalidExpression>()("ScheduleInvalidExpression", {
  expression: Schema.String,
  reason: Schema.String,
}) {}

export class IntervalTooShort extends Schema.TaggedErrorClass<IntervalTooShort>()("ScheduleIntervalTooShort", {
  expression: Schema.String,
  intervalMs: Schema.Number,
}) {}

export class LimitExceeded extends Schema.TaggedErrorClass<LimitExceeded>()("ScheduleLimitExceeded", {
  sessionID: SessionID,
  limit: Schema.Number,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("ScheduleNotFound", {
  scheduleID: ID,
}) {}

export interface Interface {
  readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly create: (input: {
    sessionID: SessionID
    expression: string
    message: string
  }) => Effect.Effect<Info, InvalidExpression | IntervalTooShort | LimitExceeded>
  readonly delete: (scheduleID: ID) => Effect.Effect<void, NotFound>
  /** Manually fire the tick for a schedule (publishes Triggered). */
  readonly tick: (scheduleID: ID) => Effect.Effect<void>
  /** Record that a fire was processed by the runner. */
  readonly recordRun: (scheduleID: ID, sessionID: SessionID, status: RunStatus, ranAt: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Schedule") {}

function validateExpression(expression: string): Effect.Effect<Cron, InvalidExpression | IntervalTooShort> {
  return Effect.gen(function* () {
    let cron: Cron
    try {
      cron = new Cron(expression, { paused: true })
    } catch (e) {
      return yield* Effect.fail(
        new InvalidExpression({
          expression,
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
    }
    const next = cron.nextRuns(2)
    if (next.length < 2) {
      return yield* Effect.fail(
        new InvalidExpression({
          expression,
          reason: "expression does not produce two future runs",
        }),
      )
    }
    const intervalMs = next[1].getTime() - next[0].getTime()
    if (intervalMs < MIN_INTERVAL_MS) {
      return yield* Effect.fail(new IntervalTooShort({ expression, intervalMs }))
    }
    return cron
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const timers = new Map<ID, { cron: Cron; sessionID: SessionID }>()

    const recordRun: Interface["recordRun"] = Effect.fn("Schedule.recordRun")(
      function* (scheduleID, sessionID, runStatus, ranAt) {
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            db.insert(ScheduleRunTable)
              .values({
                id: Identifier.create("shr", "ascending"),
                schedule_id: scheduleID,
                ran_at: ranAt,
                status: runStatus,
              })
              .run()
          }),
        )
        yield* bus.publish(Event.Ran, { scheduleID, sessionID, status: runStatus, ranAt })
      },
    )

    const tick: Interface["tick"] = Effect.fn("Schedule.tick")(function* (scheduleID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).get()),
      )
      if (!row) return
      yield* bus.publish(Event.Triggered, {
        scheduleID,
        sessionID: row.session_id as SessionID,
        message: row.message,
      })
    })

    const startTimer = (scheduleID: ID, sessionID: SessionID, expression: string) => {
      const cron = new Cron(expression, {}, () => {
        Effect.runPromise(tick(scheduleID)).catch((e) =>
          log.error("schedule timer error", {
            scheduleID,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      })
      timers.set(scheduleID, { cron, sessionID })
    }

    // Hydrate on startup, deferred via setTimeout so that the layer itself
    // can finish constructing without touching the database (the database
    // and its surrounding context are not always ready at layer-init time,
    // e.g. in tool-registry unit tests). Errors are swallowed; failed
    // hydration just means the existing rows won't get timers until the
    // next create()/list() touches the data manually.
    setTimeout(() => {
      try {
        const rows = Database.use((db) => db.select().from(ScheduleTable).all())
        for (const row of rows) {
          try {
            startTimer(row.id as ID, row.session_id as SessionID, row.expression)
          } catch (e) {
            log.error("failed to hydrate schedule", {
              scheduleID: row.id,
              error: e instanceof Error ? e.message : String(e),
            })
          }
        }
      } catch (e) {
        log.debug?.("schedule hydrate skipped", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }, 0)

    const list: Interface["list"] = Effect.fn("Schedule.list")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({
              id: ScheduleTable.id,
              session_id: ScheduleTable.session_id,
              expression: ScheduleTable.expression,
              message: ScheduleTable.message,
              created_at: ScheduleTable.created_at,
              lastRanAt: drizzleSql<
                number | null
              >`(SELECT ran_at FROM schedule_run WHERE schedule_id = ${ScheduleTable.id} AND status = 'ran' ORDER BY ran_at DESC LIMIT 1)`,
              lastRunStatus: drizzleSql<RunStatus | null>`(SELECT status FROM schedule_run WHERE schedule_id = ${ScheduleTable.id} ORDER BY ran_at DESC LIMIT 1)`,
            })
            .from(ScheduleTable)
            .where(eq(ScheduleTable.session_id, sessionID))
            .all(),
        ),
      )
      return rows.map((row) => {
        const timer = timers.get(row.id as ID)
        const nextRun = timer?.cron.nextRun()?.getTime() ?? null
        return {
          id: row.id as ID,
          sessionID: row.session_id as SessionID,
          expression: row.expression,
          message: row.message,
          createdAt: row.created_at,
          lastRanAt: row.lastRanAt ?? null,
          lastRunStatus: row.lastRunStatus ?? null,
          nextRun,
        }
      })
    })

    const create: Interface["create"] = Effect.fn("Schedule.create")(function* (input: {
      sessionID: SessionID
      expression: string
      message: string
    }) {
      yield* validateExpression(input.expression)
      const count = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ c: drizzleSql<number>`COUNT(*)` })
            .from(ScheduleTable)
            .where(eq(ScheduleTable.session_id, input.sessionID))
            .get(),
        ),
      )
      if ((count?.c ?? 0) >= MAX_PER_SESSION) {
        return yield* Effect.fail(new LimitExceeded({ sessionID: input.sessionID, limit: MAX_PER_SESSION }))
      }
      const id = Identifier.create("sch", "ascending") as ID
      const createdAt = Date.now()
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.insert(ScheduleTable)
            .values({
              id,
              session_id: input.sessionID,
              expression: input.expression,
              message: input.message,
              created_at: createdAt,
            })
            .run()
        }),
      )
      startTimer(id, input.sessionID, input.expression)
      yield* bus.publish(Event.Created, { scheduleID: id, sessionID: input.sessionID })
      return {
        id,
        sessionID: input.sessionID,
        expression: input.expression,
        message: input.message,
        createdAt,
        lastRanAt: null,
        lastRunStatus: null,
        nextRun: timers.get(id)?.cron.nextRun()?.getTime() ?? null,
      } satisfies Info
    })

    const deleteSchedule: Interface["delete"] = Effect.fn("Schedule.delete")(function* (scheduleID: ID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).get()),
      )
      if (!row) return yield* Effect.fail(new NotFound({ scheduleID }))
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run()
        }),
      )
      const timer = timers.get(scheduleID)
      if (timer) {
        timer.cron.stop()
        timers.delete(scheduleID)
      }
      yield* bus.publish(Event.Deleted, {
        scheduleID,
        sessionID: row.session_id as SessionID,
      })
    })

    return Service.of({
      list,
      create,
      delete: deleteSchedule,
      tick,
      recordRun,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Schedule from "./schedule"
