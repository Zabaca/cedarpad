import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ADR-0017: the huddle transcript — one JSONL line per finalized utterance, appended
// live by the worker. A byproduct of listening (the STT text already exists); audio is
// never recorded.

export type Utterance = { speaker: string; ts: number; text: string };

export const transcriptPath = (dir: string, canvasId: string): string =>
  join(dir, 'huddles', `${canvasId}.jsonl`);

export function appendUtterance(file: string, u: Utterance): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(u)}\n`);
}
