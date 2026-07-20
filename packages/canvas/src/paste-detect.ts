// Smart-paste detection: recognize structured content on the clipboard — a
// spreadsheet/TSV/CSV table or a JSON document — so App can place a live
// DataTable / JsonCard component instead of a wall of text. Pure: no DOM except
// the html-<table> branch (DOMParser), no tldraw.

export type DetectedPaste =
  | { kind: 'table'; columns: string[]; rows: string[][]; totalRows?: number }
  | { kind: 'json'; value: unknown };

/** A clipboard source item as tldraw hands them to external-content handlers. */
export type PasteSource = { type: string; subtype?: string; data?: unknown };

/** Parse delimiter-separated text (RFC-4180 quoting: `"` wraps a field, `""`
 * escapes a quote, newlines are allowed inside quotes — Sheets/Excel emit this
 * for both TSV and CSV). Returns rows of raw string cells. */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const push = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delim) {
      push();
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  // Flush the last row; a trailing newline leaves one empty pending cell — drop it.
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

const isNumeric = (s: string) => {
  const t = s.trim().replace(/[$,%]/g, '');
  return t !== '' && !Number.isNaN(Number(t));
};

/** Spreadsheet column letters: 0 → A, 25 → Z, 26 → AA … */
export function columnLetter(i: number): string {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

// Bound what we store in shape `data`: a synced shape carrying megabytes hurts
// every consumer (persistence, sync, agents reading the canvas).
const MAX_COLS = 64;
const MAX_CELLS = 20_000;
const CELL_MAX = 300;

/** Rows → {columns, rows}: first row becomes the header when it looks like one
 * (all non-numeric while the body has numbers); otherwise synthesize A, B, C…
 * Applies the size caps; `totalRows` is set only when rows were dropped. */
function toTable(grid: string[][], headerRow: boolean | 'auto' = 'auto'): Extract<DetectedPaste, { kind: 'table' }> {
  const clip = (r: string[]) => r.slice(0, MAX_COLS).map((c) => (c.length > CELL_MAX ? c.slice(0, CELL_MAX) : c));
  const first = clip(grid[0] ?? []);
  const body = grid.slice(1);
  const isHeader =
    headerRow === 'auto'
      ? first.every((c) => c.trim() !== '' && !isNumeric(c)) && body.some((r) => r.some(isNumeric))
      : headerRow;
  const columns = isHeader ? first : first.map((_, i) => columnLetter(i));
  const all = isHeader ? body : grid;
  const maxRows = Math.max(50, Math.floor(MAX_CELLS / Math.max(1, columns.length)));
  const rows = all.slice(0, maxRows).map(clip);
  return { kind: 'table', columns, rows, ...(all.length > rows.length ? { totalRows: all.length } : {}) };
}

/** A rectangular grid with real content: every row the same width (≥2 columns),
 * and no fully-empty leading column (the tab-indented-code artifact). */
function isRectangular(grid: string[][]): boolean {
  if (grid.length < 2) return false;
  const cols = grid[0]?.length ?? 0;
  if (cols < 2) return false;
  if (!grid.every((r) => r.length === cols)) return false;
  if (grid.every((r) => (r[0] ?? '').trim() === '')) return false;
  return true;
}

function detectDelimited(text: string): DetectedPaste | null {
  if (text.includes('\t')) {
    const grid = parseDelimited(text, '\t');
    if (isRectangular(grid)) return toTable(grid);
  }
  if (text.includes(',')) {
    // Commas appear in prose, so CSV needs a stronger signal than TSV: at least
    // three rows, all the same width. (Rectangularity does most of the work.)
    const grid = parseDelimited(text, ',');
    if (grid.length >= 3 && isRectangular(grid)) return toTable(grid);
  }
  return null;
}

/** JSON detection alone (also used by the raw-paste capture hook, where tldraw's
 * pipeline drops subtype-'json' clipboard text on the floor). Only object/array
 * roots count: a bare number or quoted string pastes better as text. */
export function detectJson(text: string): DetectedPaste | null {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    const value: unknown = JSON.parse(t);
    if (typeof value === 'object' && value !== null) return { kind: 'json', value };
  } catch {
    /* not JSON */
  }
  return null;
}

/** A `<table>` in pasted rich text (Sheets/Excel/Numbers all put one on the
 * clipboard). `<th>` cells mark an explicit header row; otherwise the same
 * numeric heuristic as delimited text decides. */
function detectHtmlTable(html: string): DetectedPaste | null {
  if (!/<table[\s>]/i.test(html) || typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const grid: string[][] = [];
  let hasTh = false;
  for (const tr of table.querySelectorAll('tr')) {
    const cells = [...tr.querySelectorAll('td,th')];
    if (cells.length === 0) continue;
    if (cells.some((c) => c.tagName === 'TH')) hasTh = grid.length === 0;
    grid.push(cells.map((c) => (c.textContent ?? '').trim()));
  }
  if (!isRectangular(grid)) return null;
  return toTable(grid, hasTh ? true : 'auto');
}

export function detectPaste(input: { text: string; html?: string; sources?: ReadonlyArray<PasteSource> }): DetectedPaste | null {
  if (input.html) {
    const d = detectHtmlTable(input.html);
    if (d) return d;
  }
  // A clipboard item tldraw already classified as JSON is decisive (its `text`
  // may be stripped HTML, which no longer parses).
  const jsonSource = input.sources?.find((s) => s.type === 'text' && s.subtype === 'json');
  if (typeof jsonSource?.data === 'string') {
    const d = detectJson(jsonSource.data);
    if (d) return d;
  }
  // Prefer the raw plain-text clipboard item: for rich pastes tldraw's `text` is
  // stripped HTML, which loses the tab structure the detectors need.
  const rawText = input.sources?.find((s) => s.type === 'text' && s.subtype === 'text');
  const text = (typeof rawText?.data === 'string' ? rawText.data : input.text).replace(/\n+$/, '');
  if (!text.trim()) return null;
  return detectJson(text) ?? detectDelimited(text);
}
