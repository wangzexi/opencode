import { afterEach, describe, expect, test } from "bun:test"
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
  test("stores worktrees in sqlite and returns project metadata from the project database for plain directories", async () => {
    await using projectDir = await tmpdir()

    await run((project) =>
      OpenedProjects.open(project, projectDir.path).pipe(
        Effect.flatMap(() =>
          OpenedProjects.meta(project, {
            worktree: projectDir.path,
            name: "db name",
            icon: { color: "pink", override: "db" },
            commands: { start: "bun dev" },
          }),
        ),
      ),
    )

    expect(await run((project) => OpenedProjects.list(project))).toEqual([
      expect.objectContaining({
        worktree: projectDir.path,
        name: "db name",
        icon: { color: "pink", override: "db" },
        commands: { start: "bun dev" },
      }),
    ])
  })
})
