import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../tabs";

function reset() {
  useTabStore.setState({
    tabs: {},
    rootPane: { type: "leaf", id: "root-pane", tabIds: [], activeTabId: null },
    focusedPaneId: "root-pane",
  });
}

describe("tabs store", () => {
  beforeEach(reset);

  it("openTab (preview) replaces an existing unpinned tab in the pane", () => {
    const s = useTabStore.getState();
    s.openTab({ kind: "file", label: "a.ts", filePath: "/a.ts" });
    const firstIds = Object.keys(useTabStore.getState().tabs);
    expect(firstIds).toHaveLength(1);

    s.openTab({ kind: "file", label: "b.ts", filePath: "/b.ts" });
    const afterIds = Object.keys(useTabStore.getState().tabs);
    expect(afterIds).toHaveLength(1); // preview replaced
    const tab = useTabStore.getState().tabs[afterIds[0]];
    expect(tab.label).toBe("b.ts");
    expect(tab.pinned).toBe(false);
  });

  it("openTab with pinned=true always creates a new tab", () => {
    const s = useTabStore.getState();
    s.openTab({ kind: "file", label: "a.ts", filePath: "/a.ts" }, true);
    s.openTab({ kind: "file", label: "b.ts", filePath: "/b.ts" }, true);
    expect(Object.keys(useTabStore.getState().tabs)).toHaveLength(2);
  });

  it("closeTab drops the tab and resets focus when nothing remains", () => {
    const s = useTabStore.getState();
    s.openTab({ kind: "file", label: "a.ts", filePath: "/a.ts" }, true);
    const id = Object.keys(useTabStore.getState().tabs)[0];
    s.closeTab(id);
    const st = useTabStore.getState();
    expect(st.tabs).toEqual({});
    expect(st.rootPane).toEqual({ type: "leaf", id: "root-pane", tabIds: [], activeTabId: null });
  });

  it("splitPane creates a split node with the tab in the new leaf", () => {
    const s = useTabStore.getState();
    s.openTab({ kind: "file", label: "a.ts", filePath: "/a.ts" }, true);
    s.openTab({ kind: "file", label: "b.ts", filePath: "/b.ts" }, true);
    const ids = Object.keys(useTabStore.getState().tabs);
    const rootPaneId = useTabStore.getState().focusedPaneId;
    s.splitPane(rootPaneId, "horizontal", ids[1]);

    const root = useTabStore.getState().rootPane;
    expect(root.type).toBe("split");
    if (root.type !== "split") throw new Error();
    expect(root.direction).toBe("horizontal");
    expect(root.children[0].type).toBe("leaf");
    expect(root.children[1].type).toBe("leaf");
  });

  it("setSplitRatio clamps ratio into [0.1, 0.9]", () => {
    const s = useTabStore.getState();
    s.openTab({ kind: "file", label: "a.ts", filePath: "/a.ts" }, true);
    s.openTab({ kind: "file", label: "b.ts", filePath: "/b.ts" }, true);
    const ids = Object.keys(useTabStore.getState().tabs);
    s.splitPane(useTabStore.getState().focusedPaneId, "horizontal", ids[1]);
    const root = useTabStore.getState().rootPane;
    if (root.type !== "split") throw new Error();
    s.setSplitRatio(root.id, 5);
    const r1 = useTabStore.getState().rootPane;
    if (r1.type !== "split") throw new Error();
    expect(r1.ratio).toBe(0.9);
    s.setSplitRatio(root.id, -1);
    const r2 = useTabStore.getState().rootPane;
    if (r2.type !== "split") throw new Error();
    expect(r2.ratio).toBe(0.1);
  });
});
