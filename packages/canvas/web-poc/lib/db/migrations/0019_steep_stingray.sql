ALTER TABLE `canvases` ADD `visibility` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `visibility` text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `created_by` text;