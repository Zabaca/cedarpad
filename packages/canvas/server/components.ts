// Scoped filesystem CRUD for agent-authored component modules. The agent can
// only touch src/canvas-components/<Name>.tsx (validated names, no path escape),
// so it stays in the locked sandbox while building a real, composable component
// library that vite compiles and the canvas dynamic-imports.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../src/canvas-components/', import.meta.url));
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

function pathFor(module: string): string {
  if (!NAME.test(module)) throw new Error(`invalid component name "${module}" — use letters/digits/_/- and no extension`);
  return `${DIR}${module}.tsx`;
}

/** Names (no extension) of every component module in the library. */
export function listComponents(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''))
    .sort();
}

export function readComponent(module: string): string {
  const p = pathFor(module);
  if (!existsSync(p)) throw new Error(`component "${module}" does not exist (list_components to see what does)`);
  return readFileSync(p, 'utf8');
}

/** Create or overwrite a module file. */
export function writeComponent(module: string, source: string): void {
  if (typeof source !== 'string' || source.trim().length === 0) throw new Error('source must be non-empty');
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(pathFor(module), source);
}

/** Per-line edit: replace a unique `oldStr` occurrence with `newStr` in a module file. */
export function editComponent(module: string, oldStr: string, newStr: string): void {
  const cur = readComponent(module);
  const first = cur.indexOf(oldStr);
  if (first === -1) throw new Error('old_string not found — read_component first and copy the exact text');
  if (cur.indexOf(oldStr, first + 1) !== -1) throw new Error('old_string is not unique — include more surrounding context');
  writeComponent(module, cur.slice(0, first) + newStr + cur.slice(first + oldStr.length));
}
