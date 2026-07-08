// Dev-agent quality gate + dedup (ADR-0007, PRD #51 slice #65) — the PURE decision core
// that decides whether a scheduled `/improve-codebase-architecture` run has anything worth
// pinging James about. A run promotes an Inbox Conversation ONLY when survivors remain; a
// quiet run (empty survivor set) promotes nothing and sleeps.
//
// Two independent drops compose here:
//   1. QUALITY BAR — a candidate must carry the fields the skill produces (a non-empty
//      title + rationale) AND clear a minimum severity. Below the bar → not worth raising.
//   2. DEDUP against DECLINED markers — the skill's own convention: when James rejects a
//      candidate with a load-bearing reason, it offers an ADR "so future architecture
//      reviews don't re-suggest it". We ground that in repo state: a declined candidate is
//      recorded as a marker file under `docs/adr/declined/<slug>.md`. The gate matches a
//      candidate's identity slug against those markers so a declined candidate is never
//      re-surfaced (while a near-but-distinct candidate still passes).
//
// The matching + filtering are PURE (unit-tested, no fs). Only `readDeclinedMarkers` touches
// the filesystem — a thin wrapper that lists the marker dir; the classification stays pure.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Candidate shape (what the skill's Explore step yields) ─────────────────────────────

/** Severity of a deepening opportunity, low→high. The bar is a threshold on this scale. */
export type Severity = 'low' | 'medium' | 'high';

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

/** A candidate surfaced by `/improve-codebase-architecture`. `slug` is its stable identity
 *  (falls back to a slugified `title`) — that's what dedup matches on. */
export interface Candidate {
  title: string;
  /** The friction that makes this worth raising — required; the skill always names it. */
  rationale: string;
  severity: Severity;
  /** Optional explicit identity; when absent the title is slugified. */
  slug?: string;
}

// ── Pure: identity slug ────────────────────────────────────────────────────────────────

/** Normalize any string to a `[a-z0-9-]` slug (same shape as declined marker filenames). */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A candidate's identity: explicit `slug` if given, else the slugified title. */
export function candidateSlug(c: Candidate): string {
  return slugify(c.slug ?? c.title);
}

// ── Pure: quality bar ──────────────────────────────────────────────────────────────────

/** Minimum severity a candidate must reach to be worth raising. Explicit + simple. */
export const QUALITY_BAR: Severity = 'medium';

/** Above the bar iff it carries the required fields (non-empty title + rationale) AND its
 *  severity is at or above `QUALITY_BAR`. */
export function meetsBar(c: Candidate): boolean {
  if (c.title.trim() === '' || c.rationale.trim() === '') return false;
  return SEVERITY_RANK[c.severity] >= SEVERITY_RANK[QUALITY_BAR];
}

// ── Pure: dedup against declined markers ───────────────────────────────────────────────

/** A candidate is declined iff its identity slug exactly matches a declined marker slug.
 *  Exact match on the normalized slug — a near-but-distinct candidate does NOT match. */
export function isDeclined(candidate: Candidate, declinedMarkers: string[]): boolean {
  const slug = candidateSlug(candidate);
  return declinedMarkers.includes(slug);
}

/** The gate: the subset worth raising. Drop anything below the bar or matching a declined
 *  marker. An empty result means the caller promotes nothing (a quiet run). */
export function filterCandidates(candidates: Candidate[], declinedMarkers: string[]): Candidate[] {
  return candidates.filter((c) => meetsBar(c) && !isDeclined(c, declinedMarkers));
}

// ── Pure: marker filename → slug ───────────────────────────────────────────────────────

/** Strip a `docs/adr/declined/` marker filename to its slug: drop the `.md` extension and an
 *  optional leading `NNNN-` numeric prefix, then normalize. */
export function declinedMarkerSlug(filename: string): string {
  const base = filename.replace(/\.md$/i, '').replace(/^\d+-/, '');
  return slugify(base);
}

// ── IO: read declined markers from the repo ────────────────────────────────────────────

/** Where declined candidates are recorded (relative to the repo root). Dedicated dir so the
 *  gate never has to classify accepted-vs-declined among the real ADRs. */
export const DECLINED_MARKERS_DIR = join('docs', 'adr', 'declined');

/** List the declined marker slugs from the repo. Thin fs wrapper — missing dir → no markers
 *  (a fresh repo has declined nothing). Matching itself stays pure (`isDeclined`). */
export function readDeclinedMarkers(repoRoot: string): string[] {
  const dir = join(repoRoot, DECLINED_MARKERS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .map(declinedMarkerSlug);
}
