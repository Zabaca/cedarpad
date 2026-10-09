// The rail navigates stages by building a FRESH URL per click (urlForStage), which drops
// whatever query params the outgoing stage had accumulated: the canvas stage's `?canvas=<id>`
// (canvas-url.ts). A
// reload restores those fine (they're read from the URL on mount), but rail navigation away
// and back forgets them. Stage memory closes that gap: Shell.tsx records `location.search`
// for the stage it's leaving, and consults it when entering a stage instead of always using
// urlForStage's bare default. Per-tab, in-memory only — deliberately not localStorage.
import { type Stage, urlForStage } from './stage';

export type StageMemory = {
  /** Record `search` as the last URL query string seen while `stage` was active. */
  remember(stage: Stage, search: string): void;
  /** The URL to navigate to when entering `stage`: its remembered search, or urlForStage's
   *  bare default when nothing has been remembered yet (a stage's first visit). */
  urlFor(stage: Stage): string;
};

export function createStageMemory(): StageMemory {
  const remembered = new Map<Stage, string>();

  return {
    remember(stage, search) {
      remembered.set(stage, search);
    },
    urlFor(stage) {
      const search = remembered.get(stage);
      if (search === undefined) return urlForStage(stage);
      return search ? `/${search}` : '/';
    },
  };
}
