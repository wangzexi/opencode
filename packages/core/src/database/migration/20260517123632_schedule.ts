import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260517123632_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        "CREATE TABLE IF NOT EXISTS `schedule` (`id` text PRIMARY KEY NOT NULL, `session_id` text NOT NULL, `expression` text NOT NULL, `message` text NOT NULL, `created_at` integer NOT NULL);",
      )
      yield* tx.run("CREATE INDEX IF NOT EXISTS `schedule_session_idx` ON `schedule` (`session_id`);")
      yield* tx.run(
        "CREATE TABLE IF NOT EXISTS `schedule_run` (`id` text PRIMARY KEY NOT NULL, `schedule_id` text NOT NULL, `ran_at` integer NOT NULL, `status` text NOT NULL, FOREIGN KEY (`schedule_id`) REFERENCES `schedule`(`id`) ON UPDATE no action ON DELETE cascade);",
      )
      yield* tx.run(
        "CREATE INDEX IF NOT EXISTS `schedule_run_idx` ON `schedule_run` (`schedule_id`,`ran_at`);",
      )
    })
  },
} satisfies DatabaseMigration.Migration
