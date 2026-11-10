-- Custom SQL migration file, put your code below! --
-- Backfill: dev-agent-ness moves off the workspace field onto the new `kind` column.
-- `workspace_id = 'dev-agent'` was a logical tag (ADR-0010), not a real workspace — the
-- runs execute on the DEFAULT workspace's container. Re-home those rows where they run
-- and carry the type in `kind`, so `workspace_id` means one thing again.
UPDATE `conversations` SET `kind` = 'dev-agent', `workspace_id` = 'default' WHERE `workspace_id` = 'dev-agent';
