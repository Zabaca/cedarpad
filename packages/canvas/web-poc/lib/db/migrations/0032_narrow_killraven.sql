CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`identifier` text,
	`label` text,
	`description` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sources_workspace_idx` ON `sources` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `observations` ADD `origin` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `observations` ADD `source_id` text REFERENCES sources(id);--> statement-breakpoint
CREATE INDEX `observations_source_idx` ON `observations` (`source_id`);