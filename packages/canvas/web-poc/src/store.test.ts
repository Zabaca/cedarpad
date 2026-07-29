import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./store.js";

const initial = useAppStore.getState();

describe("library list pagination", () => {
  beforeEach(() => useAppStore.setState(initial, true));

  it("keeps the current page across a view switch", () => {
    const s = useAppStore.getState();
    s.setListPage(3);
    s.setView("graph");
    s.setView("library");
    expect(useAppStore.getState().listPage).toBe(3);
  });

  it("keeps the chosen page size across a view switch", () => {
    const s = useAppStore.getState();
    s.setListPageSize(50);
    s.setView("settings");
    s.setView("library");
    expect(useAppStore.getState().listPageSize).toBe(50);
  });

  it("keeps the current page when the same filters are re-declared", () => {
    const s = useAppStore.getState();
    s.syncListFilters("q=|solved=false|size=10");
    s.setListPage(2);
    // A remount re-declares the identical filter signature.
    s.syncListFilters("q=|solved=false|size=10");
    expect(useAppStore.getState().listPage).toBe(2);
  });

  it("returns to the first page when the filters actually change", () => {
    const s = useAppStore.getState();
    s.syncListFilters("q=|solved=false|size=10");
    s.setListPage(4);
    s.syncListFilters("q=cache|solved=false|size=10");
    expect(useAppStore.getState().listPage).toBe(1);
  });
});
