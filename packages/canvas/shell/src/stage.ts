// Which stage the Shell is showing. The shell is the ONE chrome (ADR-0007, PRD #103): the
// rail switches these inline — no full page load — and the choice is reflected in the URL so
// a reload/bookmark lands back on the same stage.
//
// The stage rides in the query string because the shell is served from ASSETS at `/` alone.

export type Stage = 'canvas' | 'components' | 'notebook' | 'settings';

export const STAGES = ['canvas', 'components', 'notebook', 'settings'] as const satisfies readonly Stage[];

const isStage = (v: string | null): v is Stage => STAGES.includes(v as Stage);

/** The stage named by a `location.search`, defaulting to the canvas. */
export function stageFromUrl(search: string): Stage {
  const stage = new URLSearchParams(search).get('stage');
  return isStage(stage) ? stage : 'canvas';
}

/** The URL that names `stage`. The canvas is the default, so it gets the clean `/`. */
export function urlForStage(stage: Stage): string {
  return stage === 'canvas' ? '/' : `/?stage=${stage}`;
}
