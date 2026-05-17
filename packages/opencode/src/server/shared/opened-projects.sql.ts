import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const OpenedProjectTable = sqliteTable(
  "opened_project",
  {
    worktree: text().primaryKey(),
    position: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("opened_project_position_idx").on(table.position)],
)
