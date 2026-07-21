CREATE TABLE `workspace_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`full_name` text NOT NULL,
	`source` text NOT NULL,
	`encrypted_token` text,
	`added_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_repos_ws_repo_ux` ON `workspace_repos` (`workspace_id`,`full_name`);--> statement-breakpoint
CREATE INDEX `workspace_repos_ws_idx` ON `workspace_repos` (`workspace_id`);