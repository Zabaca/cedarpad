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
  /**
   * Which page of the Library list is showing. Held in the store — not the list
   * component — so the page survives the list unmounting (switching to Graph or
   * Settings and back, synthesize returning to the library). Component state
   * silently sent the user back to page 1 every time.
   */
  listPage: number;
  /** How many rows per page the Library list shows; stored for the same reason. */
  listPageSize: number;
  /** Signature of the filters the list last rendered with; see `syncListFilters`. */
  listFilterKey: string | null;
  setView: (v: View) => void;
  selectProblem: (id: string | null) => void;
  selectObservation: (id: string | null) => void;
  setScopeWorkspace: (id: string | null) => void;
  toggleSynthPick: (id: string) => void;
  clearSynthPicks: () => void;
  setListPage: (page: number) => void;
  setListPageSize: (size: number) => void;
  /**
   * Declare the filters the list is rendering with. Returns to the first page only
   * when the signature actually differs from the last one — a remount re-declaring
   * the same filters keeps the current page.
   */
  syncListFilters: (key: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "library",
  selectedProblemId: null,
  selectedObservationId: null,
  selectedKind: null,
  scopeWorkspaceId: null,
  synthPicks: [],
  listPage: 1,
  listPageSize: 10,
  listFilterKey: null,
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
  setListPage: (listPage) => set({ listPage }),
  setListPageSize: (listPageSize) => set({ listPageSize }),
  syncListFilters: (key) =>
    set((s) =>
      s.listFilterKey === key
        ? { listFilterKey: key }
        : { listFilterKey: key, listPage: 1 },
    ),
}));
