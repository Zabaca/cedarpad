// The Inbox stage's filter/selection state rides in the URL (query params), same spirit as
// stage.ts: a reload lands back on the same view/workspace/selected conversation. These are pure
// helpers (parse/serialize) so Inbox.tsx just reads them on mount and calls history.replaceState
// on change — no popstate handling needed, since replaceState never grows back/forward history.
import type { InboxView } from './contract';

const DEFAULT_VIEW: InboxView = 'needs-me';

const isInboxView = (v: string | null): v is InboxView =>
  v === 'needs-me' || v === 'open' || v === 'all' || v === 'closed';

export type InboxUrlState = {
  view: InboxView;
  workspace: string;
  conv: string | null;
};

/** The Inbox's filter/selection state named by a `location.search`, defaulting to "needs me"
 *  and no workspace filter or selected conversation. */
export function inboxStateFromUrl(search: string): InboxUrlState {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  return {
    view: isInboxView(view) ? view : DEFAULT_VIEW,
    workspace: params.get('workspace') ?? '',
    conv: params.get('conv'),
  };
}

/** `search` with `state`'s params merged in — every other param (`stage`, …) passes through
 *  untouched. `view`/`workspace`/`conv` are omitted whenever they're at their default (view) or
 *  unset (workspace/conv), so the URL stays clean. Returns the full query string (`''` or
 *  `?a=b`), ready to append to a pathname. */
export function urlWithInboxState(search: string, state: InboxUrlState): string {
  const params = new URLSearchParams(search);

  if (state.view === DEFAULT_VIEW) params.delete('view');
  else params.set('view', state.view);

  if (state.workspace) params.set('workspace', state.workspace);
  else params.delete('workspace');

  if (state.conv) params.set('conv', state.conv);
  else params.delete('conv');

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
