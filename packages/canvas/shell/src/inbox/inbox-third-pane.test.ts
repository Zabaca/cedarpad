import { describe, expect, test } from 'bun:test';

import type { InboxItem } from './contract';
import { thirdPane } from './inbox-third-pane';

// What the Inbox's third pane shows. It used to be one thing (the linked canvas); a
// dev-agent run with an open PR now competes for the same slot, so the choice is a pure
// decision with its own test rather than a tangle of ternaries in the component.

const it = (o: Partial<InboxItem>): InboxItem =>
  ({
    id: 'c',
    status: 'open',
    waitingOn: 'none',
    kind: 'chat',
    unread: false,
    summary: null,
    lastMessagePreview: null,
    workspaceId: 'w',
    canvasId: null,
    repo: null,
    prUrl: null,
    prMergedAt: null,
    assignedTo: null,
    ownerRef: null,
    visibility: 'shared',
    createdBy: null,
    lastActivity: 0,
    ...o,
  }) as InboxItem;

const PR = 'https://github.com/Zabaca/cedarpad/pull/283';

describe('thirdPane', () => {
  test('an ordinary chat with a canvas shows the canvas, with nothing to toggle', () => {
    expect(thirdPane(it({ canvasId: 'cv_1' }), null)).toEqual({ show: 'canvas', canToggle: false });
  });

  test('an ordinary chat with no canvas shows the attach panel', () => {
    expect(thirdPane(it({}), null)).toEqual({ show: 'attach', canToggle: false });
  });

  // The run's artifact is why you opened the row — so it leads when there is nothing to
  // choose between.
  test('a run with an open PR and no canvas shows the PR, with nothing to toggle', () => {
    expect(thirdPane(it({ kind: 'dev-agent', prUrl: PR }), null)).toEqual({ show: 'pr', canToggle: false });
  });

  test('a run with BOTH an open PR and a canvas leads with the PR and offers the toggle', () => {
    expect(thirdPane(it({ kind: 'dev-agent', prUrl: PR, canvasId: 'cv_1' }), null)).toEqual({
      show: 'pr',
      canToggle: true,
    });
  });

  test('the human‘s pick wins over the default while both are available', () => {
    const both = it({ kind: 'dev-agent', prUrl: PR, canvasId: 'cv_1' });
    expect(thirdPane(both, 'canvas')).toEqual({ show: 'canvas', canToggle: true });
    expect(thirdPane(both, 'pr')).toEqual({ show: 'pr', canToggle: true });
  });

  // A pick can outlive what it pointed at — switching conversations keeps the preference.
  test('a pick for a pane this conversation does not have is ignored, never a blank pane', () => {
    expect(thirdPane(it({ canvasId: 'cv_1' }), 'pr')).toEqual({ show: 'canvas', canToggle: false });
    expect(thirdPane(it({ kind: 'dev-agent', prUrl: PR }), 'canvas')).toEqual({ show: 'pr', canToggle: false });
  });

  // A merged PR is still worth showing (it links to what was landed) — but it no longer
  // outranks the canvas, because there is nothing left to do to it.
  test('once merged, the canvas leads again — the PR stays reachable by toggle', () => {
    expect(thirdPane(it({ kind: 'dev-agent', prUrl: PR, prMergedAt: 123, canvasId: 'cv_1' }), null)).toEqual({
      show: 'canvas',
      canToggle: true,
    });
  });

  test('a merged PR with no canvas still shows the PR rather than an attach panel', () => {
    expect(thirdPane(it({ kind: 'dev-agent', prUrl: PR, prMergedAt: 123 }), null)).toEqual({
      show: 'pr',
      canToggle: false,
    });
  });

  // Defence in depth: the merge action is dev-agent-only, so a stray url on an ordinary
  // chat must not conjure a PR pane.
  test('a PR url on an ordinary chat is ignored — the PR pane is dev-agent only', () => {
    expect(thirdPane(it({ prUrl: PR, canvasId: 'cv_1' }), null)).toEqual({ show: 'canvas', canToggle: false });
  });
});
