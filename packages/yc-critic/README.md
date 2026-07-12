# yc-critic

Helps founders write dramatically better YC applications through interrogation and brutal, cited critique. Deliberately NOT a drafting tool: it never writes answers (that is the competitor failure mode, see River/rivereditor.com). The moat is the per-question rubrics distilled from real accepted and rejected applications plus YC's own stated criteria.

## Layout

- `questions.yaml` - canonical current question set (39 questions, reconstructed 2026-07-12 from S25-S26 sources; `verified_against_live_form: false` - needs one pass by a logged-in human at apply.ycombinator.com).
- `rfs.md` - current YC Requests for Startups.
- `corpus/` - 338 structured records from Tier 1-4 sources (shizune 30+ apps, Dropbox/GitLab/Apptimize, Basedash + Fluently founder-annotated, Buffer rejection + reapplication deltas, PG/Seibel/Dalton/Tan reviewer criteria, video inventory for v2). Short excerpts only, cited; patterns not reproductions.
- `rubrics/` - one YAML per question: yc_intent, structural_pattern, positive_examples, failure_modes (named vocabulary: `buzzword_soup`, `small_ceiling_framing`, ...), interrogation_prompts, critique_checklist, stage_variants, cross_checks. Top-5 critical questions done; remaining ~15 pending.
- `skills/yc-critique/` - critique mode: paste draft answers, get a per-question scorecard + cross-question consistency report, every critique citing a contrasting corpus example.
- `skills/yc-interrogate/` - interrogation mode: adversarial interview with a vagueness detector (no name/number/date/event = push back), producing raw-material notes per question id.
- `calibration/` - fixtures + notes for the calibration tests (accepted app should score high, weak synthetic should fail loudly, planted cross-check conflicts must be caught).

## Runtime

The skills run in any Claude Code session against these files. Product wrapper target is cedarpad (`~/Projects/zabaca/cedarpad`): a new turn flavor + these two skills + this dir as workspace files; scorecard renders as an agent-authored canvas component. Trusted-users-only until cedarpad's multi-tenant isolation exists.

## Re-grounding the corpus

The corpus workflow script is persisted in the session workflow dir (`yc-critic-corpus`); re-run it when a new batch changes the question set or RFS list.

First calibration subject: Fredrin (jaequery/fredrin).

## cedarpad copy note

This directory is a COPY synced from the source of truth at `~/Projects/zabaca/ceo/packages/yc-critic/` (same for `.claude/skills/yc-{interrogate,critique}`). Edit there, re-copy here. Do not edit rubrics/corpus in this repo.
