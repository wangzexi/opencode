import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const ProjectIcon = Schema.Struct({
  override: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  emoji: Schema.optional(Schema.String),
})

export const ProjectCommands = Schema.Struct({
  start: Schema.optional(Schema.String),
})

export const Project = Schema.Struct({
  worktree: Schema.String,
  name: Schema.optional(Schema.String),
  expanded: Schema.optional(Schema.Boolean),
  icon: Schema.optional(ProjectIcon),
  commands: Schema.optional(ProjectCommands),
})
  .annotate({ identifier: "ProjectConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Project = Schema.Schema.Type<typeof Project>

export * as ConfigProjects from "./projects"
