CREATE TABLE `workspace_mcp_tokens` (
	`workspace_id` text NOT NULL,
	`mcp_name` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`workspace_id`, `mcp_name`)
);
