import { useEffect, useState } from 'react';

export default function EditorTest() {
  const [result, setResult] = useState('checking...');

  useEffect(() => {
    const w = window as any;
    const checks = [
      ['window.tldraw', w.tldraw],
      ['window.editor', w.editor],
      ['window.__tldraw_editor__', w.__tldraw_editor__],
      ['window.tlapp', w.tlapp],
    ];
    const found = checks.filter(([, v]) => v != null).map(([k]) => k);
    setResult(
      found.length
        ? '✅ found: ' + found.join(', ')
        : '❌ no tldraw globals on window'
    );
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: 'monospace', fontSize: 13, background: '#f5f5f5', borderRadius: 8 }}>
      <div style={{ marginBottom: 8, fontWeight: 'bold' }}>tldraw global test</div>
      <div>{result}</div>
    </div>
  );
}
