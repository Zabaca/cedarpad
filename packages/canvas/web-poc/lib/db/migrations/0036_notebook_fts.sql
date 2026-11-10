-- Custom SQL migration file, put your code below! --
-- Notebook search on D1's native FTS5 (ADR-0024). One index over both searchable
-- kinds: `record_id`/`kind`/`workspace_id` ride along UNINDEXED so a search can
-- return an identifier and stay workspace-scoped without a join back.
--
-- The index is kept in sync by TRIGGERS, not by the write paths: HTTP, MCP and UI
-- corrections all write these tables, and a sync step that lives in one of them is
-- an index that silently drifts.
CREATE VIRTUAL TABLE `notebook_fts` USING fts5(
  record_id UNINDEXED,
  kind UNINDEXED,
  workspace_id UNINDEXED,
  title,
  body,
  impact,
  tokenize = 'porter unicode61'
);--> statement-breakpoint
CREATE TRIGGER `observations_fts_insert` AFTER INSERT ON `observations` BEGIN
  INSERT INTO `notebook_fts` (record_id, kind, workspace_id, title, body, impact)
  VALUES (new.id, 'observation', new.workspace_id, new.title, new.body, coalesce(new.impact, ''));
END;--> statement-breakpoint
CREATE TRIGGER `observations_fts_update` AFTER UPDATE ON `observations` BEGIN
  DELETE FROM `notebook_fts` WHERE record_id = old.id AND kind = 'observation';
  INSERT INTO `notebook_fts` (record_id, kind, workspace_id, title, body, impact)
  VALUES (new.id, 'observation', new.workspace_id, new.title, new.body, coalesce(new.impact, ''));
END;--> statement-breakpoint
CREATE TRIGGER `observations_fts_delete` AFTER DELETE ON `observations` BEGIN
  DELETE FROM `notebook_fts` WHERE record_id = old.id AND kind = 'observation';
END;--> statement-breakpoint
CREATE TRIGGER `problems_fts_insert` AFTER INSERT ON `problems` BEGIN
  INSERT INTO `notebook_fts` (record_id, kind, workspace_id, title, body, impact)
  VALUES (new.id, 'problem', new.workspace_id, new.title, new.body, coalesce(new.impact, ''));
END;--> statement-breakpoint
CREATE TRIGGER `problems_fts_update` AFTER UPDATE ON `problems` BEGIN
  DELETE FROM `notebook_fts` WHERE record_id = old.id AND kind = 'problem';
  INSERT INTO `notebook_fts` (record_id, kind, workspace_id, title, body, impact)
  VALUES (new.id, 'problem', new.workspace_id, new.title, new.body, coalesce(new.impact, ''));
END;--> statement-breakpoint
CREATE TRIGGER `problems_fts_delete` AFTER DELETE ON `problems` BEGIN
  DELETE FROM `notebook_fts` WHERE record_id = old.id AND kind = 'problem';
END;--> statement-breakpoint
-- Backfill what is already stored, so search is complete the moment it exists.
INSERT INTO `notebook_fts` (record_id, kind, workspace_id, title, body, impact)
SELECT id, 'observation', workspace_id, title, body, coalesce(impact, '') FROM `observations`;--> statement-breakpoint
INSERT INTO `notebook_fts` (record_id, kind, workspace_id, title, body, impact)
SELECT id, 'problem', workspace_id, title, body, coalesce(impact, '') FROM `problems`;
