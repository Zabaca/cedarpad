CREATE TABLE `skill_file_versions` (
	`workspace_id` text NOT NULL,
	`skill` text NOT NULL,
	`path` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE INDEX `skill_file_versions_key_idx` ON `skill_file_versions` (`workspace_id`,`skill`,`path`,`version`);--> statement-breakpoint
CREATE TABLE `skill_files` (
	`workspace_id` text NOT NULL,
	`skill` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`rev` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	PRIMARY KEY(`workspace_id`, `skill`, `path`)
);
