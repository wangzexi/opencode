import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import type { Project as ConfigProject } from "@/config/projects"
import { Database, asc, eq } from "@/storage/db"
import { Effect } from "effect"
import { OpenedProjectTable } from "./opened-projects.sql"

const db = <T>(fn: Parameters<typeof Database.use<T>>[0]) => Effect.sync(() => Database.use(fn))
const tx = <T>(fn: Parameters<typeof Database.transaction<T>>[0]) => Effect.sync(() => Database.transaction(fn))

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
  return ProjectID.make(`worktree:${worktree}`)
}

const ensureProject = Effect.fn("OpenedProjects.ensureProject")(function* (
  project: Project.Interface,
  worktree: string,
) {
  const existing = findProject(yield* project.list(), worktree)
  if (existing) return existing

  const now = Date.now()
  const result = yield* db((tx) =>
    tx
      .insert(ProjectTable)
      .values({
        id: projectID(worktree),
        worktree,
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
      .get(),
  )
  return Project.fromRow(result)
})

function write(projects: string[]) {
  return tx((db) => {
    const now = Date.now()
    db.delete(OpenedProjectTable).run()
    if (!projects.length) return
    db.insert(OpenedProjectTable)
      .values(projects.map((worktree, position) => ({ worktree, position, time_created: now, time_updated: now })))
      .run()
  })
}

const ordered = Effect.fn("OpenedProjects.ordered")(() =>
  db((db) => db.select().from(OpenedProjectTable).orderBy(asc(OpenedProjectTable.position)).all()),
)

const list = Effect.fn("OpenedProjects.list")(function* (project: Project.Interface) {
  const opened = (yield* ordered()).map((item) => item.worktree)
  const dbProjects = yield* project.list()
  return opened.map((worktree) => fromProject(worktree, findProject(dbProjects, worktree)))
})

const open = Effect.fn("OpenedProjects.open")(function* (project: Project.Interface, worktree: string) {
  const opened = (yield* ordered()).map((item) => item.worktree)
  if (opened.includes(worktree)) return yield* list(project)
  yield* write([worktree, ...opened])
  return yield* list(project)
})

const close = Effect.fn("OpenedProjects.close")(function* (project: Project.Interface, worktree: string) {
  yield* write((yield* ordered()).map((item) => item.worktree).filter((entry) => entry !== worktree))
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
  const opened = yield* db((db) =>
    db.select({ worktree: OpenedProjectTable.worktree }).from(OpenedProjectTable).where(eq(OpenedProjectTable.worktree, input.worktree)).get(),
  )
  if (!opened) return yield* list(project)

  const existing = yield* ensureProject(project, input.worktree)

  yield* project.update({
    projectID: existing.id,
    name: input.name ?? existing.name,
    icon: input.icon ? { ...existing.icon, ...input.icon } : existing.icon,
    commands: input.commands ? { ...existing.commands, ...input.commands } : existing.commands,
  })
  return yield* list(project)
})

const reorder = Effect.fn("OpenedProjects.reorder")(function* (project: Project.Interface, projects: ConfigProject[]) {
  yield* write(projects.map((item) => item.worktree))
  return yield* list(project)
})

export const OpenedProjects = {
  list,
  open,
  close,
  meta,
  reorder,
}
