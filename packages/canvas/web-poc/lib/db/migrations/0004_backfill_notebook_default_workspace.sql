-- Custom SQL migration file, put your code below! --
-- Backfill (#57): `workspace_id` on observations/problems was formerly the Better
-- Auth organization id. It now means the PLATFORM workspace (registry / cs_workspace).
-- Every pre-existing row predates that semantics, so map them to the legacy `default`
-- workspace — nothing is lost; the data stays reachable under the default workspace.
UPDATE `observations` SET `workspace_id` = 'default';--> statement-breakpoint
UPDATE `problems` SET `workspace_id` = 'default';
