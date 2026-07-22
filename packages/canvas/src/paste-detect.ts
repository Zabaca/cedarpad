// Smart-paste detection: recognize structured content on the clipboard — a
// spreadsheet/TSV/CSV table or a JSON document — so App can place a live
// DataTable / JsonCard component instead of a wall of text. Pure: no DOM except
// the html-<table> branch (DOMParser), no tldraw.

export type DetectedPaste =
  | { kind: 'table'; columns: string[]; rows: string[][]; totalRows?: number }
  | { kind: 'json'; value: unknown }
  | { kind: 'markdown'; md: string }
  | { kind: 'mermaid'; chart: string }
  | { kind: 'html'; html: string }
  | { kind: 'github'; repo: string; url: string }
  | { kind: 'code'; code: string; lang?: string };

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
  // Header when row 0 is all labels and the body carries data-like cells —
  // numbers, but also emails/phones/URLs/dates, so "First Name, Email, Phone"
  // over contact rows reads as the header it is.
  const dataLike = (c: string) =>
    isNumeric(c) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim()) || /^\+?[\d][\d\s\-().]{5,}$/.test(c.trim()) || /^https?:\/\//.test(c.trim()) || /^\d{4}-\d{2}-\d{2}/.test(c.trim());
  const isHeader =
    headerRow === 'auto'
      ? first.every((c) => c.trim() !== '' && !dataLike(c)) && body.some((r) => r.some(dataLike))
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

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const cellText = (v: unknown): string =>
  v == null ? '' : typeof v === 'object' ? JSON.stringify(v).slice(0, CELL_MAX) : String(v).slice(0, CELL_MAX);

/** A JSON array of flat records (the classic API response) is really a table. */
function tabularJson(value: unknown): DetectedPaste | null {
  if (!Array.isArray(value) || value.length < 2 || !value.every(isPlainObject)) return null;
  const columns: string[] = [];
  for (const o of value) {
    for (const k of Object.keys(o)) if (!columns.includes(k)) columns.push(k);
    if (columns.length >= MAX_COLS) break;
  }
  if (columns.length < 2) return null;
  const maxRows = Math.max(50, Math.floor(MAX_CELLS / columns.length));
  const rows = value.slice(0, maxRows).map((o) => columns.slice(0, MAX_COLS).map((k) => cellText(o[k])));
  return { kind: 'table', columns: columns.slice(0, MAX_COLS), rows, ...(value.length > rows.length ? { totalRows: value.length } : {}) };
}

/** JSON detection alone (also used by the raw-paste capture hook, where tldraw's
 * pipeline drops subtype-'json' clipboard text on the floor). Only object/array
 * roots count: a bare number or quoted string pastes better as text. An array of
 * flat records becomes a table — that's what the data actually is. */
export function detectJson(text: string): DetectedPaste | null {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    const value: unknown = JSON.parse(t);
    if (typeof value === 'object' && value !== null) return tabularJson(value) ?? { kind: 'json', value };
  } catch {
    /* not JSON */
  }
  return null;
}

// Keyword-only diagrams (gantt, timeline, …) must be the WHOLE first line — a YAML doc whose
// top key is `timeline:` or `gantt:` must not be claimed (mermaid then renders a blank SVG).
const MERMAID_RE = /^(flowchart\s+\w+|graph\s+(TB|TD|BT|RL|LR)\b|pie\b(?!:)|(sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|mindmap|journey|timeline)\s*$)/;

/** Raw Mermaid source (first non-empty line names a diagram type). */
// One YAML-plausible line: a document marker, comment, list item, or `key:`/`key: value`.
const YAML_LINE = /^(---\s*|#.*|\s*-\s+\S.*|\s*[\w."'$-]+:\s*(\S.*)?)$/;

/** YAML paste → a CodeCard (lang `yaml`). Conservative: every non-empty line must be
 *  YAML-plausible AND there must be structural evidence — a `---` document start, an
 *  indented block, or a top-level list item — so prose that merely contains colons stays
 *  text. Rendered as source (no parser dependency); braces/semicolon lines (JSON, CSS,
 *  JS object literals) are excluded. */
export function detectYaml(text: string): DetectedPaste | null {
  const lines = text.replace(/\n+$/, '').split('\n');
  const content = lines.filter((l) => l.trim() !== '');
  if (content.length < 2) return null;
  if (!content.every((l) => YAML_LINE.test(l) && !/[,{};]\s*$/.test(l))) return null;
  const first = content[0] as string;
  const evidence = /^---\s*$/.test(first) || content.some((l) => /^\s+\S/.test(l)) || content.some((l) => /^-\s+\S/.test(l));
  if (!evidence) return null;
  if (!content.some((l) => /^\s*[\w."'$-]+:/.test(l))) return null; // an indented list alone isn't yaml
  return { kind: 'code', code: text.trim(), lang: 'yaml' };
}

export function detectMermaid(text: string): DetectedPaste | null {
  const first = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return MERMAID_RE.test(first) ? { kind: 'mermaid', chart: text.trim() } : null;
}

/** A paste that is exactly one fenced code block: ```mermaid → diagram, ```html
 * → live html card, any other lang → code card. (Fences inside a longer text
 * read as markdown.) */
function detectFence(text: string): DetectedPaste | null {
  const m = text.trim().match(/^```([\w-]*)[ \t]*\n([\s\S]*?)\n?```$/);
  if (!m) return null;
  const [, lang = '', code = ''] = m;
  if (!code.trim()) return null;
  if (lang === 'mermaid') return { kind: 'mermaid', chart: code };
  if (lang === 'html' || lang === 'htm') return { kind: 'html', html: code };
  return { kind: 'code', code, ...(lang ? { lang } : {}) };
}

/** Pasted HTML SOURCE (the plain text is markup — from an editor, a view-source,
 * an LLM reply), not a rich-text copy: a rendered-page copy carries tags only in
 * the clipboard's html item while its plain text is prose, so it never lands
 * here. Claims a full document (doctype/<html>) outright; a fragment needs a
 * real open tag AND a matching close tag, so `<hello>` prose stays text. */
// github.com's first path segment is only an owner when it isn't one of GitHub's own
// routes — pasting github.com/features/copilot must NOT become a repo card.
const GITHUB_RESERVED = new Set([
  'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories',
  'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login',
  'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'readme', 'search',
  'security', 'settings', 'signup', 'site', 'sponsors', 'team', 'topics', 'trending',
]);

/** A pasted GitHub repo reference → a GithubRepoCard. Claims the https URL in any depth
 *  (repo root, /tree/, /blob/, /pull/…, all normalize to owner/name) and the SSH clone
 *  string (git@github.com:owner/name.git). Single-line pastes only. */
export function detectGithubUrl(text: string): DetectedPaste | null {
  const t = text.trim();
  if (!t || t.includes('\n')) return null;
  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(t);
  if (ssh) {
    const repo = `${ssh[1]}/${ssh[2]}`;
    return { kind: 'github', repo, url: `https://github.com/${repo}` };
  }
  const web = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]\S*)?$/.exec(t);
  if (!web) return null;
  const owner = web[1] as string;
  const name = web[2] as string;
  if (GITHUB_RESERVED.has(owner.toLowerCase())) return null;
  return { kind: 'github', repo: `${owner}/${name}`, url: t };
}

export function detectHtml(text: string): DetectedPaste | null {
  const t = text.trim();
  if (!t.startsWith('<')) return null;
  if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) return { kind: 'html', html: t };
  const open = /^<([a-zA-Z][\w-]*)[\s>/]/.exec(t);
  if (!open) return null;
  return new RegExp(`</[a-zA-Z][\\w-]*>`).test(t) && /<\w[^>]*>[\s\S]*<\/\w/.test(t) ? { kind: 'html', html: t } : null;
}

/** Markdown wants a strong signal: a heading, three-plus list lines, a pipe
 * table, or an embedded fence — plain prose must stay a text shape. */
export function looksLikeMarkdown(text: string): boolean {
  if (/^#{1,6} .+/m.test(text)) return true;
  if (/^```/m.test(text)) return true;
  if (/^\|.+\|\s*$/m.test(text) && /^\|[-| :]+\|\s*$/m.test(text)) return true;
  const listLines = text.split('\n').filter((l) => /^\s*([-*+] |\d+\. )/.test(l)).length;
  return listLines >= 3;
}

/** File-drop detection: the extension IS the signal, so no heuristics — just
 * parse per type. Unknown extensions return null (tldraw's flow keeps them). */
export function detectFromFile(name: string, text: string): DetectedPaste | null {
  const ext = /\.(\w+)$/.exec(name.toLowerCase())?.[1];
  switch (ext) {
    case 'csv':
    case 'tsv': {
      const grid = parseDelimited(text.replace(/\n+$/, ''), ext === 'tsv' ? '\t' : ',');
      return grid.length > 0 && (grid[0]?.length ?? 0) > 0 ? toTable(grid) : null;
    }
    case 'json':
      return detectJson(text) ?? { kind: 'code', code: text, lang: 'json' };
    case 'md':
    case 'markdown':
      return { kind: 'markdown', md: text };
    case 'mmd':
    case 'mermaid':
      return { kind: 'mermaid', chart: text.trim() };
    case 'html':
    case 'htm':
      return { kind: 'html', html: text };
    case 'yaml':
    case 'yml':
      // The extension is authoritative — no content heuristics for a named .yaml file.
      return { kind: 'code', code: text.trim(), lang: 'yaml' };
    default:
      return null;
  }
}

/** Extensions the drop hook claims; anything else stays with tldraw. */
export const STRUCTURED_FILE_RE = /\.(csv|tsv|json|md|markdown|mmd|mermaid|html|htm|yaml|yml)$/i;

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
  return (
    detectFence(text) ??
    detectGithubUrl(text) ??
    detectHtml(text) ??
    detectMermaid(text) ??
    detectJson(text) ??
    detectYaml(text) ??
    detectDelimited(text) ??
    (looksLikeMarkdown(text) ? { kind: 'markdown', md: text } : null)
  );
}
