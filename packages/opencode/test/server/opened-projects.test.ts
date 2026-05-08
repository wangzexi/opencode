import { afterEach, describe, expect, test } from "bun:test"
import { Config } from "@/config/config"
import { emptyConsoleState } from "@/config/console-state"
import { Project } from "@/project/project"
import { OpenedProjects } from "@/server/shared/opened-projects"
import { Effect } from "effect"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

function run<A>(fn: (project: Project.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const project = yield* Project.Service
      return yield* fn(project)
    }).pipe(Effect.provide(Project.defaultLayer)),
  )
}

afterEach(async () => {
  await resetDatabase()
})

describe("OpenedProjects", () => {
  test("stores only worktrees in config and returns project metadata from the project database for plain directories", async () => {
    await using projectDir = await tmpdir()

    let globalConfig: Config.Info = {
      projects: [{ worktree: projectDir.path }],
    }
    const config = Config.Service.of({
      get: () => Effect.succeed({}),
      getGlobal: () => Effect.succeed(globalConfig),
      update: () => Effect.void,
      updateGlobal: (next) =>
        Effect.sync(() => {
          globalConfig = next
          return { info: globalConfig, changed: true }
        }),
      invalidate: () => Effect.void,
      directories: () => Effect.succeed([]),
      getConsoleState: () => Effect.succeed(emptyConsoleState),
      waitForDependencies: () => Effect.void,
    })

    await run((project) =>
      OpenedProjects.meta(config, project, {
        worktree: projectDir.path,
        name: "db name",
        icon: { color: "pink", override: "db" },
        commands: { start: "bun dev" },
      }),
    )

    expect(globalConfig).toEqual({ projects: [{ worktree: projectDir.path }] })
    expect(await run((project) => OpenedProjects.list(config, project))).toEqual([
      expect.objectContaining({
        worktree: projectDir.path,
        name: "db name",
        icon: { color: "pink", override: "db" },
        commands: { start: "bun dev" },
      }),
    ])
  })
})
