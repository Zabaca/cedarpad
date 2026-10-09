// What a placed component may read live (ADR-0024): a named Notebook query, never a URL and
// never a statement. One zod contract both the placing side and the rendering side parse at
// the boundary (CLAUDE.md §7).

import { z } from 'zod';

import { NotebookSourceSchema } from './notebook-source.ts';

export const DataSourceSchema = z.discriminatedUnion('kind', [NotebookSourceSchema]);
export type DataSource = z.infer<typeof DataSourceSchema>;

/** A component placed before the warehouse was retired (ADR-0017) may still carry
 *  `{kind:'mart', name}`. It reads as NO source — the component falls back to its static
 *  `data` — rather than failing the whole shape on load or on its next edit. */
export function isRetiredDataSource(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'mart';
}
