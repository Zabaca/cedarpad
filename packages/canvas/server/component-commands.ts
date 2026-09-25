// Loads a component's `commands` export for `call_component`. A component declares its edits
// as named zod-typed pure reducers in its own .tsx (next to the default export), and the
// server imports that same file to run them — one set of rules for the UI and the agent.
//
// The import is the resolved file at `?v=<hash of its source>`: Bun caches a module per
// specifier, so the query string is what makes an edited component's new commands visible
// without a restart, and an unchanged one is not re-evaluated. A content hash rather than the
// instance `rev`, because revs are per canvas and a shared module is one file — two canvases
// can reach the same rev with different sources. Only the component itself is reloaded; a
// sibling it imports stays whatever Bun first loaded.

import { readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';

import { type ComponentCommands, type OpResult, callComponentOp } from '../src/canvas-ops.ts';
import type { CanvasStore } from '../src/store.ts';
import { resolveComponentFile } from './components.ts';

const CommandsExport = z.record(
  z.object({
    // Duck-typed rather than `instanceof z.ZodType`: a component on a different zod entry
    // (`zod/v4`) is still a schema, and `safeParse` is all the op calls.
    args: z.custom<z.ZodTypeAny>((v) => typeof (v as { safeParse?: unknown } | null)?.safeParse === 'function', 'must be a zod schema'),
    run: z.custom<ComponentCommands[string]['run']>((v) => typeof v === 'function', 'must be a function'),
  }),
);

/** The component's commands, `{}` when it declares none. Throws a readable Error when the
 * module cannot be imported on the server or its `commands` export is the wrong shape. */
export async function loadCommands(
  module: string,
  canvasId: string,
  resolve: (module: string, canvasId: string) => Promise<string> = resolveComponentFile,
): Promise<ComponentCommands> {
  // The realpath, because Bun resolves a symlinked path with a query to "Cannot find module".
  const path = realpathSync(await resolve(module, canvasId));
  let mod: Record<string, unknown>;
  try {
    mod = await import(`${path}?v=${Bun.hash(readFileSync(path)).toString(36)}`);
  } catch (e) {
    throw new Error(
      `could not load <${module}> on the server to run its commands: ${(e as Error).message}. A component with commands must not touch window/document at the top level of its file.`,
    );
  }
  if (mod.commands === undefined) return {};
  const parsed = CommandsExport.safeParse(mod.commands);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`<${module}> exports \`commands\` in the wrong shape (want { name: { args: zod schema, run: (data, args) => data } }): ${issues}`);
  }
  return parsed.data;
}

/** `call_component`: load the instance's module's commands, then run one against the
 * instance's live data. Shared by the chat tool and the bridge route (the MCP edge). */
export async function callComponent(
  store: CanvasStore,
  canvasId: string,
  id: string,
  command: string,
  args: unknown,
  load: (module: string, canvasId: string) => Promise<ComponentCommands> = loadCommands,
): Promise<OpResult> {
  const shape = store.getState().shapes.find((s) => s.id === id);
  if (!shape || shape.type !== 'component') return callComponentOp(store, id, {}, command, args);
  return callComponentOp(store, id, await load(shape.module, canvasId), command, args);
}
