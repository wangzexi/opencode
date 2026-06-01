import { Project } from "@/project/project"
import type { Project as ConfigProject } from "@/config/projects"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { OpenedProjectTable } from "./opened-projects.sql"

function findProject(projects: Project.Info[], worktree: string) {
  return projects.find((project) => project.worktree === worktree || project.sandboxes.includes(worktree))
}

function fromProject(worktree: string, project?: Project.Info): ConfigProject {
  return {
    worktree,
    ...(project?.name !== undefined ? { name: project.name } : {}),
    ...(project?.icon ? { icon: { color: project.icon.color, override: project.icon.override } } : {}),
    ...(project?.commands ? { commands: project.commands } : {}),
  }
}

function projectID(worktree: string) {
  return ProjectV2.ID.make(`worktree:${worktree}`)
}

const ensureProject = Effect.fn("OpenedProjects.ensureProject")(function* (
  db: Database.Interface["db"],
  project: Project.Interface,
  worktree: string,
) {
  const existing = findProject(yield* project.list(), worktree)
  if (existing) return existing

  const now = Date.now()
  const result = yield* db
    .insert(ProjectTable)
    .values({
      id: projectID(worktree),
      worktree: AbsolutePath.make(worktree),
      vcs: null,
      time_created: now,
      time_updated: now,
      time_initialized: null,
      sandboxes: [],
    })
    .onConflictDoUpdate({
      target: ProjectTable.id,
      set: {
        time_updated: now,
      },
    })
    .returning()
    .get()
    .pipe(Effect.orDie)
  return Project.fromRow(result)
})

function write(db: Database.Interface["db"], projects: string[]) {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* tx.delete(OpenedProjectTable).run()
        if (!projects.length) return
        yield* tx
          .insert(OpenedProjectTable)
          .values(projects.map((worktree, position) => ({ worktree, position, time_created: now, time_updated: now })))
          .run()
      }),
    )
    .pipe(Effect.orDie)
}

const ordered = Effect.fn("OpenedProjects.ordered")((db: Database.Interface["db"]) =>
  db.select().from(OpenedProjectTable).orderBy(asc(OpenedProjectTable.position)).all().pipe(Effect.orDie),
)

const list = Effect.fn("OpenedProjects.list")(function* (project: Project.Interface) {
  const { db } = yield* Database.Service
  const opened = (yield* ordered(db)).map((item) => item.worktree)
  const dbProjects = yield* project.list()
  return opened.map((worktree) => fromProject(worktree, findProject(dbProjects, worktree)))
})

const open = Effect.fn("OpenedProjects.open")(function* (project: Project.Interface, worktree: string) {
  const { db } = yield* Database.Service
  const opened = (yield* ordered(db)).map((item) => item.worktree)
  if (opened.includes(worktree)) return yield* list(project)
  yield* write(db, [worktree, ...opened])
  return yield* list(project)
})

const close = Effect.fn("OpenedProjects.close")(function* (project: Project.Interface, worktree: string) {
  const { db } = yield* Database.Service
  yield* write(
    db,
    (yield* ordered(db)).map((item) => item.worktree).filter((entry) => entry !== worktree),
  )
  return yield* list(project)
})

const meta = Effect.fn("OpenedProjects.meta")(function* (
  project: Project.Interface,
  input: {
    worktree: string
    name?: string
    icon?: { color?: string; override?: string }
    commands?: { start?: string }
  },
) {
  const { db } = yield* Database.Service
  const opened = yield* db
    .select({ worktree: OpenedProjectTable.worktree })
    .from(OpenedProjectTable)
    .where(eq(OpenedProjectTable.worktree, input.worktree))
    .get()
    .pipe(Effect.orDie)
  if (!opened) return yield* list(project)

  const existing = yield* ensureProject(db, project, input.worktree)

  yield* project
    .update({
      projectID: existing.id,
      name: input.name ?? existing.name,
      icon: input.icon ? { ...existing.icon, ...input.icon } : existing.icon,
      commands: input.commands ? { ...existing.commands, ...input.commands } : existing.commands,
    })
    .pipe(Effect.catch(() => Effect.void))
  return yield* list(project)
})

const reorder = Effect.fn("OpenedProjects.reorder")(function* (project: Project.Interface, projects: ConfigProject[]) {
  const { db } = yield* Database.Service
  yield* write(db, projects.map((item) => item.worktree))
  return yield* list(project)
})

export const OpenedProjects = {
  list,
  open,
  close,
  meta,
  reorder,
}
