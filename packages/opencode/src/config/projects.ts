import { Schema } from "effect"

export const ProjectIcon = Schema.Struct({
  override: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
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
}).annotate({ identifier: "ProjectConfig" })
export type Project = Schema.Schema.Type<typeof Project>

export * as ConfigProjects from "./projects"
