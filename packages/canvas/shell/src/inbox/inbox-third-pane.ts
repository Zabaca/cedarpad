import type { InboxItem } from './contract';

// What the Inbox's third pane shows. It was one thing (the conversation's linked canvas);
// a dev-agent run with an open PR now wants the same slot, so the choice is a pure decision
// here rather than a knot of ternaries in the component.
//
// The rule: while a PR is still open it LEADS — it is the reason you opened the row, and it
// is the only pane with an action on it. Once merged there is nothing left to do to it, so
// the canvas leads again and the PR stays reachable by toggle as the record of what landed.

/** Which of the three the pane is showing. `attach` is the canvas pane's empty state. */
export type ThirdPane = 'pr' | 'canvas' | 'attach';

export interface ThirdPaneChoice {
  show: ThirdPane;
  /** True when this conversation has BOTH a PR and a canvas — the only time there is
   *  anything to switch between, and so the only time the toggle is rendered. */
  canToggle: boolean;
}

/**
 * @param preferred the human's sticky pick, or null for the default. A pick for a pane this
 *   conversation does not have is ignored (it outlives the row it was made on), so switching
 *   conversations can never land you on a blank pane.
 */
export function thirdPane(item: InboxItem, preferred: 'pr' | 'canvas' | null): ThirdPaneChoice {
  // A PR pane is dev-agent-only, mirroring the merge action itself: an ordinary chat can
  // never conjure one, whatever its row happens to carry.
  const hasPr = item.kind === 'dev-agent' && !!item.prUrl;
  const hasCanvas = !!item.canvasId;
  const canToggle = hasPr && hasCanvas;

  if (!hasPr) return { show: hasCanvas ? 'canvas' : 'attach', canToggle: false };
  if (!hasCanvas) return { show: 'pr', canToggle: false };
  if (preferred) return { show: preferred, canToggle };
  return { show: item.prMergedAt ? 'canvas' : 'pr', canToggle };
}
