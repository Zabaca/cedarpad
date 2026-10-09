// How a component instance names the Notebook data it renders (ADR-0024: a component names
// a query, not a URL). A notebook source names a QUERY out of a fixed registry plus its
// params — never a statement, so no free-form SQL can cross the boundary even from a caller
// that is otherwise trusted to place a component.

import { z } from 'zod';

/** The named queries a canvas may read. Adding one is a deliberate contract change
 * (CLAUDE.md §7): the name is the boundary. */
export const NOTEBOOK_QUERIES = ['open_problems', 'problem_observations', 'recent_observations'] as const;
export const NotebookQueryName = z.enum(NOTEBOOK_QUERIES);
export type NotebookQueryName = z.infer<typeof NotebookQueryName>;

/** A query's params as they ride on the shape and in the route's query string — scalars
 * only. Each query validates its OWN params (worker/notebook-data-api.ts); this is just
 * the wire shape both sides agree on. */
export const NotebookParams = z.record(z.union([z.string(), z.number()]));
export type NotebookParams = z.infer<typeof NotebookParams>;

export const NotebookSourceSchema = z.object({
  kind: z.literal('notebook'),
  query: NotebookQueryName,
  params: NotebookParams.optional(),
});
export type NotebookSource = z.infer<typeof NotebookSourceSchema>;

/** A Notebook row as it crosses the boundary — flat and JSON-safe. */
export type NotebookRow = Record<string, string | number | boolean | null>;
