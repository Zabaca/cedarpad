CREATE TABLE `component_record_versions` (
	`workspace_id` text NOT NULL,
	`canvas_id` text,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE INDEX `component_record_versions_key_idx` ON `component_record_versions` (`workspace_id`,`canvas_id`,`name`,`version`);--> statement-breakpoint
CREATE TABLE `component_records` (
	`workspace_id` text NOT NULL,
	`canvas_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`rev` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by` text,
	`deleted_at` integer,
	PRIMARY KEY(`workspace_id`, `canvas_id`, `name`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `component_records_shared_name_idx` ON `component_records` (`workspace_id`,`name`) WHERE canvas_id is null;