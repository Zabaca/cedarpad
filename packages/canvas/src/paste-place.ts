// Turn a DetectedPaste into a placed component shape: DataTable for tables,
// JsonCard for JSON. detectedShapeSpec is pure (module + data + size); the
// wiring lives in App's onMount. Also owns the capture-phase paste hook that
// rescues raw JSON — tldraw classifies it subtype 'json' and then drops it.
import { createShapeId, type Editor } from 'tldraw';

import { columnLayout } from './canvas-components/DataTable';
import { detectFromFile, detectJson, STRUCTURED_FILE_RE, type DetectedPaste } from './paste-detect';

const CH_PX = 7.2; // ≈ one ch at the card's 12px font
const ROW_H = 28;

export function detectedShapeSpec(d: DetectedPaste): { module: string; data: Record<string, unknown>; w: number; h: number } {
  if (d.kind === 'table') {
    const cols = columnLayout(d.columns, d.rows);
    const w = Math.round(Math.min(800, Math.max(320, cols.reduce((sum, c) => sum + c.ch * CH_PX + 20, 0) + 4)));
    const h = Math.round(Math.min(520, Math.max(140, (d.rows.length + 1) * ROW_H + 26)));
    return { module: 'DataTable', data: { columns: d.columns, rows: d.rows, ...(d.totalRows ? { totalRows: d.totalRows } : {}) }, w, h };
  }
  if (d.kind === 'mermaid') return { module: 'MermaidDiagram', data: { chart: d.chart }, w: 480, h: 380 };
  if (d.kind === 'markdown') {
    const lines = d.md.split('\n').length;
    return { module: 'MarkdownCard', data: { markdown: d.md }, w: 460, h: Math.round(Math.min(560, Math.max(200, lines * 20 + 40))) };
  }
  if (d.kind === 'code') {
    const lines = d.code.split('\n');
    const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
    return {
      module: 'CodeCard',
      data: { code: d.code, ...(d.lang ? { lang: d.lang } : {}) },
      w: Math.round(Math.min(760, Math.max(320, maxLen * CH_PX + 70))),
      h: Math.round(Math.min(520, Math.max(140, lines.length * 18 + 46))),
    };
  }
  return { module: 'JsonCard', data: { value: d.value }, w: 420, h: 360 };
}

export function placeDetected(editor: Editor, d: DetectedPaste, point?: { x: number; y: number }): void {
  const { module, data, w, h } = detectedShapeSpec(d);
  const p = point ?? editor.getViewportPageBounds().center;
  const id = createShapeId();
  editor.createShape({ id, type: 'component', x: p.x - w / 2, y: p.y - h / 2, props: { w, h, module, data, rev: 1 } });
  editor.select(id);
}

/** Capture-phase rescues for content tldraw's pipeline can't route to us:
 * (1) plain-text JSON pastes — tldraw tags them subtype 'json' and then no
 * branch handles that, so pasting raw JSON silently does nothing; (2) drops of
 * structured files (.csv/.tsv/.json/.md/.mmd), which would otherwise become
 * opaque asset blobs. Both mirror tldraw's "should the canvas take this" guards;
 * anything else stays with tldraw's own flow (our 'text' handler sees it there). */
export function wirePasteCapture(editor: Editor): () => void {
  const doc = editor.getContainer().ownerDocument;
  const onPaste = (e: ClipboardEvent) => {
    if (!editor.getInstanceState().isFocused) return;
    if (editor.getEditingShapeId() !== null || editor.menus.hasAnyOpenMenus()) return;
    const ae = doc.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const dt = e.clipboardData;
    if (!dt || dt.types.includes('text/html') || dt.types.includes('Files')) return;
    const d = detectJson(dt.getData('text/plain'));
    if (!d) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    editor.markHistoryStoppingPoint('paste');
    placeDetected(editor, d);
  };
  // Claim a drop only when EVERY file is one of ours — a mixed drop (image +
  // csv) stays with tldraw so the image path isn't broken.
  const container = editor.getContainer();
  const onDrop = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0 || !files.every((f) => STRUCTURED_FILE_RE.test(f.name))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const p = editor.screenToPage({ x: e.clientX, y: e.clientY });
    editor.markHistoryStoppingPoint('paste');
    files.forEach((f, i) => {
      void f.text().then((text) => {
        const d = detectFromFile(f.name, text);
        if (d) placeDetected(editor, d, { x: p.x + i * 24, y: p.y + i * 24 });
      });
    });
  };
  doc.addEventListener('paste', onPaste, { capture: true });
  container.addEventListener('drop', onDrop, { capture: true });
  return () => {
    doc.removeEventListener('paste', onPaste, { capture: true });
    container.removeEventListener('drop', onDrop, { capture: true });
  };
}
