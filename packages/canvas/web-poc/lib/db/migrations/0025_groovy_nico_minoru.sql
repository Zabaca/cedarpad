CREATE TABLE `workspace_connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connector_name` text NOT NULL,
	`encrypted_secret` text NOT NULL,
	`added_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_connectors_ws_name_ux` ON `workspace_connectors` (`workspace_id`,`connector_name`);--> statement-breakpoint
CREATE INDEX `workspace_connectors_ws_idx` ON `workspace_connectors` (`workspace_id`);