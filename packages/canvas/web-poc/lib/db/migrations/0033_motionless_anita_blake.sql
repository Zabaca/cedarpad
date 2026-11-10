DROP TABLE `agent_jobs`;--> statement-breakpoint
DROP TABLE `agent_runs`;--> statement-breakpoint
DROP TABLE `cluster_summaries`;--> statement-breakpoint
DROP TABLE `observation_links`;--> statement-breakpoint
DROP TABLE `observation_solved_match_dismissals`;--> statement-breakpoint
ALTER TABLE `observations` DROP COLUMN `source`;--> statement-breakpoint
ALTER TABLE `observations` DROP COLUMN `embedding`;--> statement-breakpoint
ALTER TABLE `observations` DROP COLUMN `embedding_model`;--> statement-breakpoint
ALTER TABLE `problems` DROP COLUMN `embedding`;--> statement-breakpoint
ALTER TABLE `problems` DROP COLUMN `embedding_model`;--> statement-breakpoint
ALTER TABLE `solutions` DROP COLUMN `embedding`;