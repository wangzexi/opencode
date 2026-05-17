import { Bus } from "@/bus"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Layer } from "effect"
import { SessionPrompt } from "./prompt"
import { Schedule } from "./schedule"
import { SessionStatus } from "./status"

// Re-exported so app-runtime / tests can wire ScheduleRunner without dropping
// SessionStatus/SessionPrompt provided at the same level.

const log = Log.create({ service: "schedule.runner" })

/**
 * Listens for {@link Schedule.Event.Triggered}, decides whether to actually
 * inject the message (skip if the session is busy), and records the run.
 *
 * Kept separate from {@link Schedule.Service} so that the Schedule service
 * itself does not depend on {@link SessionPrompt.Service}.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const prompt = yield* SessionPrompt.Service
    const schedule = yield* Schedule.Service

    yield* bus.subscribeCallback(Schedule.Event.Triggered, (event) =>
      Effect.gen(function* () {
        const { scheduleID, sessionID, message } = event.properties
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
            Effect.catch((e) =>
              Effect.sync(() =>
                log.error("schedule fire failed", {
                  scheduleID,
                  error: e instanceof Error ? e.message : String(e),
                }),
              ),
            ),
          )
        yield* schedule.recordRun(scheduleID, sessionID, "ran", ranAt)
      }),
    )
  }),
)

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
    Layer.provide(Bus.layer),
  ),
)

export * as ScheduleRunner from "./schedule-runner"
