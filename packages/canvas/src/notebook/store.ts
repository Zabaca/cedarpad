import { create } from "zustand";

type View = "library" | "graph" | "settings";
type Kind = "observation" | "problem";

interface AppState {
  view: View;
  selectedProblemId: string | null;
  selectedObservationId: string | null;
  /** Which detail panel the unified Library view shows for the current selection. */
  selectedKind: Kind | null;
  /** View scope: which workspace the lists/graph show. `null` = all workspaces. */
  scopeWorkspaceId: string | null;
  /**
   * Observation ids picked for "Synthesize problem", in selection order. Held in
   * the store (not the list component) so the selection survives pagination,
   * search, workspace-scope changes, and switching between Library/Graph views —
   * synthesize can gather observations chosen across all of them. Synthesis is
   * cross-workspace, so picks from different workspaces are intentionally kept.
   */
  synthPicks: string[];
  setView: (v: View) => void;
  selectProblem: (id: string | null) => void;
  selectObservation: (id: string | null) => void;
  setScopeWorkspace: (id: string | null) => void;
  toggleSynthPick: (id: string) => void;
  clearSynthPicks: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "library",
  selectedProblemId: null,
  selectedObservationId: null,
  selectedKind: null,
  scopeWorkspaceId: null,
  synthPicks: [],
  setView: (view) => set({ view }),
  // Only one item is ever active, so selecting one kind clears the other —
  // otherwise both rows stay highlighted in the list.
  selectProblem: (selectedProblemId) =>
    set({
      selectedProblemId,
      selectedObservationId: null,
      selectedKind: selectedProblemId ? "problem" : null,
    }),
  selectObservation: (selectedObservationId) =>
    set({
      selectedObservationId,
      selectedProblemId: null,
      selectedKind: selectedObservationId ? "observation" : null,
    }),
  setScopeWorkspace: (scopeWorkspaceId) => set({ scopeWorkspaceId }),
  toggleSynthPick: (id) =>
    set((s) => ({
      synthPicks: s.synthPicks.includes(id)
        ? s.synthPicks.filter((x) => x !== id)
        : [...s.synthPicks, id],
    })),
  clearSynthPicks: () => set({ synthPicks: [] }),
}));
