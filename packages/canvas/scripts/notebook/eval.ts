/**
 * Print the agent eval report.
 *
 * Deterministic (heuristic) by default:
 *   bun apps/api/scripts/eval.ts
 *
 * Exercise the real LLM + graph tool loop by supplying provider keys:
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun apps/api/scripts/eval.ts
 *
 * (OpenAI key drives embeddings; the chat provider key drives reasoning. With
 * no keys it falls back to the hash embedder + heuristic reasoner.)
 */
import type { Bindings } from "../../server/notebook/context.js";
import { type ProbeOutcome, runEval, setupEvalDb } from "../../server/notebook/eval.js";

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const mark = (ok: boolean) => (ok ? "✓" : "✗");

function line(p: ProbeOutcome): string {
  const links = p.linkedTo.map((l) => `${l.toProblemId}:${l.kind}`).join(", ") || "—";
  return [
    `${mark(p.linkRecall === 1 && p.reuseCorrect)} ${p.id}`,
    `recall=${pct(p.linkRecall)}`,
    `reuse=${p.reused}(want ${p.expectReuse})`,
    `origin=${p.origin}`,
    `links=[${links}]`,
  ].join("  ");
}

async function main() {
  const { db, close } = await setupEvalDb();
  try {
    const report = await runEval(db, process.env as unknown as Bindings);
    console.log(`\nAgent eval — model: ${report.providerModel}\n`);
    for (const p of report.probes) console.log(line(p));
    console.log(
      `\nlink recall: ${pct(report.linkRecall)}   reuse accuracy: ${pct(report.reuseAccuracy)}\n`,
    );
    if (report.linkRecall < 1 || report.reuseAccuracy < 1) process.exitCode = 1;
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
