-- Custom SQL migration file, put your code below! --
-- The Notebook is retired (ADR-0024 superseded). Its FTS5 index is a virtual table
-- drizzle does not model, so 0037 could not drop it; its sync triggers went with
-- `observations`/`problems` there. Dropping the virtual table drops its shadow tables.
DROP TABLE IF EXISTS `notebook_fts`;
