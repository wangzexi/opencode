CREATE TABLE `opened_project` (
	`worktree` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `opened_project_position_idx` ON `opened_project` (`position`);
