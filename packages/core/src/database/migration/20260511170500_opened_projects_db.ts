import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260511170500_opened_projects_db",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        "CREATE TABLE IF NOT EXISTS `opened_project` (`worktree` text PRIMARY KEY NOT NULL, `position` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL);",
      )
      yield* tx.run("CREATE INDEX IF NOT EXISTS `opened_project_position_idx` ON `opened_project` (`position`);")
    })
  },
} satisfies DatabaseMigration.Migration
