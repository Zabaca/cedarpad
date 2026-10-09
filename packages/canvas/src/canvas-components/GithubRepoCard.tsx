// GitHub Repo reference card: pasting a GitHub URL onto the canvas places one of these. A
// link with a name, nothing more — the workspace no longer connects or clones repos.
import * as React from 'react';

export default function GithubRepoCard({ repo = '', url = '' }: { repo?: string; url?: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#fff',
        borderRadius: 8,
        padding: 12,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{ fontSize: 16 }}>🐙</span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{ font: '600 14px/1.3 system-ui, sans-serif', color: '#111827', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={url}
      >
        {repo || 'github repo'}
      </a>
    </div>
  );
}
