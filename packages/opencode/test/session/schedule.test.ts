import { expect } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Queue } from "effect"
import { BackgroundJob } from "../../src/background/job"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { SessionPrompt } from "../../src/session/prompt"
import { ScheduleRunner } from "../../src/session/schedule-runner"
import { Schedule } from "../../src/session/schedule"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { Storage } from "../../src/storage/storage"
import { pollWithTimeout, testEffect } from "../lib/effect"

let promptQueue: Queue.Queue<SessionPrompt.PromptInput> | undefined

const promptLayer = Layer.effect(
  SessionPrompt.Service,
  Effect.gen(function* () {
    return SessionPrompt.Service.of({
      cancel: () => Effect.void,
      prompt: (input) =>
        Effect.gen(function* () {
          if (!promptQueue) return yield* Effect.die("prompt queue not set")
          yield* Queue.offer(promptQueue, input)
          if (input.parts.some((part) => part.type === "text" && part.text === "die after submit")) {
            return yield* Effect.die("submitted then failed")
          }
          return undefined as unknown as SessionV1.WithParts
        }),
      loop: () => Effect.succeed(undefined as unknown as SessionV1.WithParts),
      shell: () => Effect.succeed(undefined as unknown as SessionV1.WithParts),
      command: () => Effect.succeed(undefined as unknown as SessionV1.WithParts),
      resolvePromptParts: () => Effect.succeed([]),
    })
  }),
)

const events = EventV2Bridge.defaultLayer
const status = SessionStatus.layer.pipe(Layer.provideMerge(events))
const schedule = Schedule.layer.pipe(Layer.provideMerge(events), Layer.provide(Database.defaultLayer))
const session = Session.layer.pipe(
  Layer.provideMerge(events),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(BackgroundJob.defaultLayer),
)
const runner = ScheduleRunner.layer.pipe(
  Layer.provideMerge(events),
  Layer.provideMerge(status),
  Layer.provideMerge(schedule),
  Layer.provideMerge(promptLayer),
)

const it = testEffect(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    promptLayer,
    events,
    status,
    schedule,
    session,
    runner,
  ),
)

const takePrompt = (queue: Queue.Queue<SessionPrompt.PromptInput>) =>
  Effect.race(
    Queue.take(queue),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error("timed out waiting for prompt")))),
  )

const waitForRunStatus = (schedules: Schedule.Interface, sessionID: SessionID, status: Schedule.RunStatus) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const items = yield* schedules.list(sessionID)
      return items[0]?.lastRunStatus === status ? items[0] : undefined
    }),
    `timed out waiting for schedule run status ${status}`,
  )

const scheduleEventTypes = (events: GlobalEvent[], sessionID: SessionID) =>
  events
    .filter((event) => event.payload?.properties?.sessionID === sessionID)
    .map((event) => event.payload?.type)

it.instance("creates, lists, triggers, records, and deletes a scheduled task", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const schedules = yield* Schedule.Service
    const runner = yield* ScheduleRunner.Service
    const queue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    promptQueue = queue

    const session = yield* sessions.create({ title: "schedule test" })
    const events: GlobalEvent[] = []
    const onEvent = (event: GlobalEvent) => {
      events.push(event)
    }
    GlobalBus.on("event", onEvent)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))
    yield* runner.init()

    const created = yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "scheduled hello",
    })

    expect((yield* schedules.list(session.id)).map((item) => item.id)).toEqual([created.id])
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.created")

    yield* schedules.tick(created.id)
    const prompt = yield* takePrompt(queue)

    expect(prompt.sessionID).toBe(session.id)
    expect(prompt.parts).toEqual([
      {
        type: "text",
        text: "scheduled hello",
        metadata: { source: "schedule", scheduleId: created.id },
      },
    ])

    const ran = yield* waitForRunStatus(schedules, session.id, "ran")
    expect(ran.lastRanAt).toBeNumber()
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.triggered")
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.ran")

    yield* schedules.delete(created.id)
    expect(yield* schedules.list(session.id)).toEqual([])
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.deleted")
  }),
)

it.instance("records a skipped run when the session is busy", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const schedules = yield* Schedule.Service
    const runner = yield* ScheduleRunner.Service
    const status = yield* SessionStatus.Service
    promptQueue = yield* Queue.unbounded<SessionPrompt.PromptInput>()

    const session = yield* sessions.create({ title: "schedule busy test" })
    yield* runner.init()
    yield* status.set(session.id, { type: "busy" })

    const created = yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "scheduled while busy",
    })

    yield* schedules.tick(created.id)
    const skipped = yield* waitForRunStatus(schedules, session.id, "skipped")
    expect(skipped.lastRanAt).toBeNumber()
  }),
)

it.instance("records a ran status when prompt submission fails after adding the message", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const schedules = yield* Schedule.Service
    const runner = yield* ScheduleRunner.Service
    promptQueue = yield* Queue.unbounded<SessionPrompt.PromptInput>()

    const session = yield* sessions.create({ title: "schedule prompt failure test" })
    yield* runner.init()

    const created = yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "die after submit",
    })

    yield* schedules.tick(created.id)
    const ran = yield* waitForRunStatus(schedules, session.id, "ran")
    expect(ran.lastRanAt).toBeNumber()
  }),
)
