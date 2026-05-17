CREATE TABLE `schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`expression` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedule_session_idx` ON `schedule` (`session_id`);
--> statement-breakpoint
CREATE TABLE `schedule_run` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`ran_at` integer NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedule`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedule_run_idx` ON `schedule_run` (`schedule_id`,`ran_at`);
