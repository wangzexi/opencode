import type { Config } from "@/config/config"
import type { Project as ConfigProject } from "@/config/projects"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { Database } from "@/storage/db"
import { Effect } from "effect"

const db = <T>(fn: Parameters<typeof Database.use<T>>[0]) => Effect.sync(() => Database.use(fn))

function openedOnly(projects: ConfigProject[]) {
  return projects.map((project) => ({ worktree: project.worktree }))
}

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
          worktree,
          time_updated: now,
        },
      })
      .returning()
      .get(),
  )
  return Project.fromRow(result)
})

const list = Effect.fn("OpenedProjects.list")(function* (config: Config.Interface, project: Project.Interface) {
  const cfg = yield* config.getGlobal()
  const opened = openedOnly(cfg.projects ?? [])
  const dbProjects = yield* project.list()
  return opened.map((entry) => fromProject(entry.worktree, findProject(dbProjects, entry.worktree)))
})

const open = Effect.fn("OpenedProjects.open")(function* (
  config: Config.Interface,
  project: Project.Interface,
  worktree: string,
) {
  const cfg = yield* config.getGlobal()
  const opened = openedOnly(cfg.projects ?? [])
  if (opened.some((entry) => entry.worktree === worktree)) return yield* list(config, project)
  yield* config.updateGlobal({ ...cfg, projects: [{ worktree }, ...opened] })
  return yield* list(config, project)
})

const close = Effect.fn("OpenedProjects.close")(function* (
  config: Config.Interface,
  project: Project.Interface,
  worktree: string,
) {
  const cfg = yield* config.getGlobal()
  yield* config.updateGlobal({
    ...cfg,
    projects: openedOnly(cfg.projects ?? []).filter((entry) => entry.worktree !== worktree),
  })
  return yield* list(config, project)
})

const meta = Effect.fn("OpenedProjects.meta")(function* (
  config: Config.Interface,
  project: Project.Interface,
  input: {
    worktree: string
    name?: string
    icon?: { color?: string; override?: string }
    commands?: { start?: string }
  },
) {
  const cfg = yield* config.getGlobal()
  if (!(cfg.projects ?? []).some((entry) => entry.worktree === input.worktree)) return yield* list(config, project)

  const existing = yield* ensureProject(project, input.worktree)

  yield* project.update({
    projectID: existing.id,
    name: input.name ?? existing.name,
    icon: input.icon ? { ...existing.icon, ...input.icon } : existing.icon,
    commands: input.commands ? { ...existing.commands, ...input.commands } : existing.commands,
  })
  return yield* list(config, project)
})

const reorder = Effect.fn("OpenedProjects.reorder")(function* (
  config: Config.Interface,
  project: Project.Interface,
  projects: ConfigProject[],
) {
  const cfg = yield* config.getGlobal()
  yield* config.updateGlobal({ ...cfg, projects: openedOnly(projects) })
  return yield* list(config, project)
})

export const OpenedProjects = {
  list,
  open,
  close,
  meta,
  reorder,
}
