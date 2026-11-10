CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`waiting_on` text DEFAULT 'none' NOT NULL,
	`unread` integer DEFAULT false NOT NULL,
	`last_activity` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`owner_ref` text,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`summary` text,
	`last_message_preview` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_user_idx` ON `conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `conversations_status_idx` ON `conversations` (`status`);--> statement-breakpoint
CREATE INDEX `conversations_last_activity_idx` ON `conversations` (`last_activity`);