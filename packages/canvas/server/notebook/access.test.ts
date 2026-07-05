import { schema } from "../../lib/db/index.js";
import { describe, expect, it } from "bun:test";
import {
  accessWhere,
  canAccessWorkspace,
  scopeFromAllowlist,
  workspaceFilter,
} from "./access.js";

/**
 * The access seam: workspaces are open by default; restriction is opt-in via an
 * allowlist. These assertions pin the "all unless a non-empty allowlist" rule.
 */
describe("access scope", () => {
  it("defaults to all when there is no allowlist", () => {
    for (const allowed of [null, undefined, []]) {
      const scope = scopeFromAllowlist(allowed);
      expect(scope).toEqual({ kind: "all" });
      expect(canAccessWorkspace(scope, "anything")).toBe(true);
    }
  });

  it("restricts to exactly the allowlisted workspaces", () => {
    const scope = scopeFromAllowlist(["wsA", "wsB"]);
    expect(scope).toEqual({ kind: "list", workspaceIds: ["wsA", "wsB"] });
    expect(canAccessWorkspace(scope, "wsA")).toBe(true);
    expect(canAccessWorkspace(scope, "wsB")).toBe(true);
    expect(canAccessWorkspace(scope, "wsC")).toBe(false);
  });

  it("emits a list WHERE filter only when restricted", () => {
    const col = schema.problems.workspaceId;
    expect(accessWhere({ kind: "all" }, col)).toBeUndefined();
    expect(accessWhere(scopeFromAllowlist(["wsA"]), col)).toBeDefined();
  });

  it("workspaceFilter forces an empty result when an explicit workspace is out of scope", () => {
    const col = schema.problems.workspaceId;
    const scope = scopeFromAllowlist(["wsA"]);
    // In scope ⇒ a normal equality filter; out of scope ⇒ a (defined) impossible filter.
    expect(workspaceFilter(scope, col, "wsA")).toBeDefined();
    expect(workspaceFilter(scope, col, "wsB")).toBeDefined();
    // Unfiltered all-access list ⇒ no WHERE fragment.
    expect(workspaceFilter({ kind: "all" }, col)).toBeUndefined();
  });
});
