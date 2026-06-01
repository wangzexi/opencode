import { GlobalBus, type GlobalEvent } from "../bus/global"
import { EffectBridge } from "../effect/bridge"
import { InstanceState } from "../effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Context, Effect, Layer, Scope } from "effect"
import { SessionPrompt } from "./prompt"
import { Schedule } from "./schedule"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

// Re-exported so app-runtime / tests can wire ScheduleRunner without dropping
// SessionStatus/SessionPrompt provided at the same level.

const log = Log.create({ service: "schedule.runner" })

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduleRunner") {}

/**
 * Listens for {@link Schedule.Event.Triggered}, decides whether to actually
 * inject the message (skip if the session is busy), and records the run.
 *
 * Kept separate from {@link Schedule.Service} so that the Schedule service
 * itself does not depend on {@link SessionPrompt.Service}.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const prompt = yield* SessionPrompt.Service
    const schedule = yield* Schedule.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make(
      Effect.fn("ScheduleRunner.state")(function* (ctx) {
        const bridge = yield* EffectBridge.make()
        const onTriggered = (event: GlobalEvent) => {
          if (event.directory !== ctx.directory) return
          if (!isTriggered(event.payload)) return
          bridge.fork(
            Effect.gen(function* () {
              const { scheduleID, sessionID, message } = event.payload.properties
              const sessionStatus = yield* status.get(sessionID)
              const ranAt = Date.now()
              if (sessionStatus.type === "busy") {
                yield* schedule.recordRun(scheduleID, sessionID, "skipped", ranAt)
                return
              }
              yield* prompt
                .prompt({
                  sessionID,
                  parts: [
                    {
                      type: "text",
                      text: message,
                      metadata: { source: "schedule", scheduleId: scheduleID },
                    },
                  ],
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() =>
                      log.error("schedule fire failed", {
                        scheduleID,
                        cause: Cause.pretty(cause),
                      }),
                    ),
                  ),
                  Effect.forkIn(scope, { startImmediately: true }),
                  Effect.asVoid,
                )
              yield* schedule.recordRun(scheduleID, sessionID, "ran", ranAt)
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error("schedule runner failed", {
                    scheduleID: event.payload.properties.scheduleID,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
            ),
          )
        }
        GlobalBus.on("event", onTriggered)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onTriggered)))
      }),
    )

    const init = Effect.fn("ScheduleRunner.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

function isTriggered(value: GlobalEvent["payload"]): value is {
  type: typeof Schedule.Event.Triggered.type
  properties: {
    scheduleID: Schedule.ID
    sessionID: SessionID
    message: string
  }
} {
  if (typeof value !== "object" || value === null) return false
  if (value.type !== Schedule.Event.Triggered.type) return false
  if (typeof value.properties !== "object" || value.properties === null) return false
  return (
    typeof value.properties.scheduleID === "string" &&
    typeof value.properties.sessionID === "string" &&
    typeof value.properties.message === "string"
  )
}

/**
 * Self-contained ScheduleRunner layer. Provides Schedule.Service to consumers
 * (via provideMerge) and pulls in SessionPrompt + SessionStatus as fully-
 * provided default layers so the result has only ambient app dependencies
 * left (Database / Config / etc., provided by AppLayer).
 */
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provideMerge(Schedule.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
  ),
)

export * as ScheduleRunner from "./schedule-runner"
