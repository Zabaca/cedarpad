PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`impact` text,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text DEFAULT 'human' NOT NULL,
	`project_tags` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`embedding` F32_BLOB(1024),
	`embedding_model` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_observations`("id", "workspace_id", "title", "body", "impact", "status", "source", "project_tags", "created_by", "embedding", "embedding_model", "created_at", "updated_at") SELECT "id", "workspace_id", "title", "body", "impact", "status", "source", "project_tags", "created_by", "embedding", "embedding_model", "created_at", "updated_at" FROM `observations`;--> statement-breakpoint
DROP TABLE `observations`;--> statement-breakpoint
ALTER TABLE `__new_observations` RENAME TO `observations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `observations_workspace_idx` ON `observations` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `__new_problems` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`impact` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`urgency` text DEFAULT 'medium' NOT NULL,
	`solution_direction` text,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text DEFAULT 'human' NOT NULL,
	`project_tags` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`embedding` F32_BLOB(1024),
	`embedding_model` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_problems`("id", "workspace_id", "title", "body", "impact", "priority", "urgency", "solution_direction", "status", "source", "project_tags", "created_by", "embedding", "embedding_model", "created_at", "updated_at") SELECT "id", "workspace_id", "title", "body", "impact", "priority", "urgency", "solution_direction", "status", "source", "project_tags", "created_by", "embedding", "embedding_model", "created_at", "updated_at" FROM `problems`;--> statement-breakpoint
DROP TABLE `problems`;--> statement-breakpoint
ALTER TABLE `__new_problems` RENAME TO `problems`;--> statement-breakpoint
CREATE INDEX `problems_workspace_idx` ON `problems` (`workspace_id`);