// Turn a DetectedPaste into a placed component shape: DataTable for tables,
// JsonCard for JSON. detectedShapeSpec is pure (module + data + size); the
// wiring lives in App's onMount. Also owns the capture-phase paste hook that
// rescues raw JSON — tldraw classifies it subtype 'json' and then drops it.
import { createShapeId, type Editor } from 'tldraw';

import { columnLayout } from './canvas-components/DataTable';
import { detectJson, type DetectedPaste } from './paste-detect';

const CH_PX = 7.2; // ≈ one ch at the card's 12px font
const ROW_H = 28;

export function detectedShapeSpec(d: DetectedPaste): { module: string; data: Record<string, unknown>; w: number; h: number } {
  if (d.kind === 'table') {
    const cols = columnLayout(d.columns, d.rows);
    const w = Math.round(Math.min(800, Math.max(320, cols.reduce((sum, c) => sum + c.ch * CH_PX + 20, 0) + 4)));
    const h = Math.round(Math.min(520, Math.max(140, (d.rows.length + 1) * ROW_H + 26)));
    return { module: 'DataTable', data: { columns: d.columns, rows: d.rows, ...(d.totalRows ? { totalRows: d.totalRows } : {}) }, w, h };
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

/** Rescue plain-text JSON pastes: tldraw's clipboard flow tags them subtype
 * 'json' and no branch handles that, so pasting raw JSON silently does nothing.
 * This capture-phase listener places a JsonCard instead, mirroring tldraw's own
 * "should the canvas take this paste" guards. Anything with html/files on the
 * clipboard stays with tldraw's pipeline (our 'text' handler sees it there). */
export function wireJsonPaste(editor: Editor): () => void {
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
  doc.addEventListener('paste', onPaste, { capture: true });
  return () => doc.removeEventListener('paste', onPaste, { capture: true });
}
