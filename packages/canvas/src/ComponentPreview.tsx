// Renders ONE component module, with no canvas around it. What `?preview=<Module>` shows.
//
// Deliberately thinner than `ComponentGuestView`: there is no room connection, no shape, no
// `data`. A preview answers "what does this look like", not "what is this instance showing"
// — so it opens no WebSocket and reads nothing from D1.
//
// CONSEQUENCE, worth stating rather than hiding: a component receives its placement `data`
// as props, and a preview has none. A component written to expect `data.rows` renders empty
// or throws here. That IS the honest answer for an unconfigured instance, and the error is
// shown rather than swallowed — a component that cannot survive empty props is a thing worth
// seeing before you place one.

import * as React from 'react';

import { loadComponent, type AgentComponent } from './component-loader';

/** Catches a render-time throw so one bad component shows a message instead of a blank
 *  frame. A load failure is handled below; this is specifically "it compiled, then threw". */
class PreviewBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="preview-error">
          <strong>Render error</strong>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ComponentPreview({ module, canvasId }: { module: string; canvasId: string }) {
  const [C, setC] = React.useState<AgentComponent | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    // `rev` 0: a preview has no instance whose revision could have been bumped, and the
    // loader keys its cache by (canvas, module, rev) — so every preview of a module shares
    // one compile rather than forcing a fresh import per open.
    loadComponent(module, 0, canvasId)
      .then((loaded) => alive && setC(() => loaded))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [module, canvasId]);

  if (error) {
    return (
      <div className="preview-error">
        <strong>Could not load {module}</strong>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!C) return <div className="preview-loading">Loading {module}…</div>;
  return (
    <PreviewBoundary>
      <C />
    </PreviewBoundary>
  );
}
