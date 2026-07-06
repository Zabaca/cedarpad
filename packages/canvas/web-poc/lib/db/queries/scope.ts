/**
 * The graph knowledge layer (similarity, traversal, solved-neighbours, cluster
 * summaries) is cross-workspace by design: identical observations and problems
 * are recognised across every tenant so solutions can be reused. There is no
 * caller-selectable scope. Workspace scoping survives only for plain listing of
 * a tenant's own observations/problems, where callers apply
 * `eq(workspaceId, ...)` inline.
 */
