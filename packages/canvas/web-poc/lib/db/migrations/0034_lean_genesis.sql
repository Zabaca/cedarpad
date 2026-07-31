PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`impact` text,
	`status` text DEFAULT 'open' NOT NULL,
	`origin` text DEFAULT 'human' NOT NULL,
	`source_id` text,
	`project_tags` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_observations`("id", "workspace_id", "title", "body", "impact", "status", "origin", "source_id", "project_tags", "created_by", "created_at", "updated_at") SELECT "id", "workspace_id", "title", "body", "impact", "status", "origin", "source_id", "project_tags", "created_by", "created_at", "updated_at" FROM `observations`;--> statement-breakpoint
DROP TABLE `observations`;--> statement-breakpoint
ALTER TABLE `__new_observations` RENAME TO `observations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `observations_workspace_idx` ON `observations` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `observations_source_idx` ON `observations` (`source_id`);