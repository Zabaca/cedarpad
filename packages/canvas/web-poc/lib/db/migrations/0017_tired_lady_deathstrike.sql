CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by` text NOT NULL,
	`guest_chat` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `share_links_canvas_idx` ON `share_links` (`canvas_id`);