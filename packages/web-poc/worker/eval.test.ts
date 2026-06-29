import { beforeAll, describe, expect, it } from "vitest";
import type { Bindings } from "./context.js";
import { type EvalReport, runEval, setupEvalDb } from "./eval.js";

/**
 * Regression guard over the deterministic (no-key) pipeline path. Asserts the
 * golden-set invariants rather than exact scores, so it stays stable while the
 * heuristics evolve. Run `bun --filter @cedarpad/api eval` for the full report.
 */
describe("agent eval (deterministic heuristic path)", () => {
  let report: EvalReport;

  beforeAll(async () => {
    const { db } = await setupEvalDb();
    report = await runEval(db, {} as Bindings);
  });

  const probe = (id: string) => report.probes.find((p) => p.id === id)!;

  it("runs the heuristic path (no provider keys)", () => {
    expect(report.providerModel).toBe("heuristic");
  });

  it("links a near-duplicate and reuses its accepted solution", () => {
    const q1 = probe("eval_q1");
    expect(q1.linkedTo.map((l) => l.toProblemId)).toContain("eval_e1");
    expect(q1.reused).toBe(true);
  });

  it("links a near-duplicate with no solution but does not reuse", () => {
    const q2 = probe("eval_q2");
    expect(q2.linkedTo.map((l) => l.toProblemId)).toContain("eval_e2");
    expect(q2.reused).toBe(false);
  });

  it("neither links nor reuses for an unrelated problem", () => {
    const q3 = probe("eval_q3");
    expect(q3.linkedTo.some((l) => l.kind === "identical")).toBe(false);
    expect(q3.reused).toBe(false);
  });

  it("scores perfect recall and reuse on the golden set", () => {
    expect(report.linkRecall).toBe(1);
    expect(report.reuseAccuracy).toBe(1);
  });
});
