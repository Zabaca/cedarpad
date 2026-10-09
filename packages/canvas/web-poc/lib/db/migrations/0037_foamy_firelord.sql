DROP TABLE `apikey`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
DROP TABLE `job_run_stamps`;--> statement-breakpoint
DROP TABLE `observation_problems`;--> statement-breakpoint
DROP TABLE `observations`;--> statement-breakpoint
DROP TABLE `problem_links`;--> statement-breakpoint
DROP TABLE `problems`;--> statement-breakpoint
DROP TABLE `push_subscriptions`;--> statement-breakpoint
DROP TABLE `solution_links`;--> statement-breakpoint
DROP TABLE `solutions`;--> statement-breakpoint
DROP TABLE `sources`;--> statement-breakpoint
DROP TABLE `workspace_connectors`;--> statement-breakpoint
DROP TABLE `workspace_repos`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `repo`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `github_installation_id`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `github_installations`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `selected_repos`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `inbox_read_at`;