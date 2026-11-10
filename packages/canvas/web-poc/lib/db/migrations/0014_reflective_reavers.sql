CREATE TABLE `job_run_stamps` (
	`workspace_id` text NOT NULL,
	`repo` text NOT NULL,
	`job` text NOT NULL,
	`last_run_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `repo`, `job`)
);
