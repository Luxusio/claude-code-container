import { create } from "zustand";

export interface Tab {
  id: string;
  kind: "terminal" | "file" | "diff";
  label: string;
  pinned: boolean;
  filePath?: string;
  sessionId?: string;
  /** For diff tabs: project root that owns the file */
  projectPath?: string;
}

export type PaneNode =
  | { type: "leaf"; id: string; tabIds: string[]; activeTabId: string | null }
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      children: [PaneNode, PaneNode];
      ratio: number;
    };

const ROOT_PANE_ID = "root-pane";

function makeLeaf(id?: string): PaneNode & { type: "leaf" } {
  return { type: "leaf", id: id ?? crypto.randomUUID(), tabIds: [], activeTabId: null };
}

/** Recursively collapse empty leaves out of split nodes. */
function collapsePaneTree(node: PaneNode): PaneNode {
  if (node.type === "leaf") return node;
  const left = collapsePaneTree(node.children[0]);
  const right = collapsePaneTree(node.children[1]);
  if (left.type === "leaf" && left.tabIds.length === 0) return right;
  if (right.type === "leaf" && right.tabIds.length === 0) return left;
  return { ...node, children: [left, right] };
}

/** Find a leaf pane by id in the tree. */
function findLeaf(node: PaneNode, paneId: string): (PaneNode & { type: "leaf" }) | null {
  if (node.type === "leaf") return node.id === paneId ? node : null;
  return findLeaf(node.children[0], paneId) ?? findLeaf(node.children[1], paneId);
}

/** Find which leaf pane contains the given tabId. */
function findPaneContainingTab(node: PaneNode, tabId: string): string | null {
  if (node.type === "leaf") return node.tabIds.includes(tabId) ? node.id : null;
  return findPaneContainingTab(node.children[0], tabId) ?? findPaneContainingTab(node.children[1], tabId);
}

/** Update a specific leaf in the tree (immutable). */
function updateLeaf(
  node: PaneNode,
  paneId: string,
  updater: (leaf: PaneNode & { type: "leaf" }) => PaneNode & { type: "leaf" }
): PaneNode {
  if (node.type === "leaf") {
    return node.id === paneId ? updater(node) : node;
  }
  return {
    ...node,
    children: [
      updateLeaf(node.children[0], paneId, updater),
      updateLeaf(node.children[1], paneId, updater),
    ] as [PaneNode, PaneNode],
  };
}

/** Replace a leaf node with an arbitrary PaneNode. */
function replaceNode(tree: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (tree.type === "leaf") {
    return tree.id === targetId ? replacement : tree;
  }
  return {
    ...tree,
    children: [
      replaceNode(tree.children[0], targetId, replacement),
      replaceNode(tree.children[1], targetId, replacement),
    ] as [PaneNode, PaneNode],
  };
}

/** Collect all leaf pane ids. */
function allLeafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...allLeafIds(node.children[0]), ...allLeafIds(node.children[1])];
}

interface TabState {
  tabs: Record<string, Tab>;
  rootPane: PaneNode;
  focusedPaneId: string;

  // Tab operations
  openTab: (tab: Omit<Tab, "id" | "pinned">, pinned?: boolean) => void;
  closeTab: (tabId: string) => void;
  pinTab: (tabId: string) => void;

  // Pane operations
  setActiveTab: (paneId: string, tabId: string) => void;
  setFocusedPane: (paneId: string) => void;
  reorderTab: (paneId: string, fromIdx: number, toIdx: number) => void;
  moveTab: (tabId: string, fromPaneId: string, toPaneId: string, index?: number) => void;
  splitPane: (paneId: string, direction: "horizontal" | "vertical", tabId: string) => void;
  setSplitRatio: (splitPaneId: string, ratio: number) => void;

  // Helpers
  getTabsForPane: (paneId: string) => Tab[];
  findPaneForTab: (tabId: string) => string | null;
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: {},
  rootPane: makeLeaf(ROOT_PANE_ID),
  focusedPaneId: ROOT_PANE_ID,

  openTab: (tabData, pinned = false) => {
    set((state) => {
      const paneId = state.focusedPaneId;
      const leaf = findLeaf(state.rootPane, paneId);
      if (!leaf) return state;

      const newTabs = { ...state.tabs };

      if (pinned) {
        const id = crypto.randomUUID();
        const newTab: Tab = { ...tabData, id, pinned: true };
        newTabs[id] = newTab;
        const newRoot = updateLeaf(state.rootPane, paneId, (l) => ({
          ...l,
          tabIds: [...l.tabIds, id],
          activeTabId: id,
        }));
        return { tabs: newTabs, rootPane: newRoot };
      }

      // Preview: find existing unpinned tab in this pane to replace
      const unpinnedId = leaf.tabIds.find((tid) => newTabs[tid] && !newTabs[tid].pinned);
      if (unpinnedId) {
        newTabs[unpinnedId] = { ...tabData, id: unpinnedId, pinned: false };
        const newRoot = updateLeaf(state.rootPane, paneId, (l) => ({
          ...l,
          activeTabId: unpinnedId,
        }));
        return { tabs: newTabs, rootPane: newRoot };
      }

      // No unpinned tab — create new preview
      const id = crypto.randomUUID();
      newTabs[id] = { ...tabData, id, pinned: false };
      const newRoot = updateLeaf(state.rootPane, paneId, (l) => ({
        ...l,
        tabIds: [...l.tabIds, id],
        activeTabId: id,
      }));
      return { tabs: newTabs, rootPane: newRoot };
    });
  },

  closeTab: (tabId) => {
    set((state) => {
      const paneId = findPaneContainingTab(state.rootPane, tabId);
      if (!paneId) return state;

      const newTabs = { ...state.tabs };
      delete newTabs[tabId];

      let newRoot = updateLeaf(state.rootPane, paneId, (l) => {
        const remaining = l.tabIds.filter((id) => id !== tabId);
        const newActive =
          l.activeTabId === tabId
            ? remaining.length > 0
              ? remaining[remaining.length - 1]
              : null
            : l.activeTabId;
        return { ...l, tabIds: remaining, activeTabId: newActive };
      });

      // Collapse empty panes
      newRoot = collapsePaneTree(newRoot);

      // If root collapsed to nothing, reset to a single empty leaf
      if (newRoot.type === "leaf" && newRoot.tabIds.length === 0) {
        newRoot = makeLeaf(ROOT_PANE_ID);
      }

      // Ensure focusedPaneId is still valid
      const leafIds = allLeafIds(newRoot);
      const focusedPaneId = leafIds.includes(state.focusedPaneId)
        ? state.focusedPaneId
        : leafIds[0] ?? ROOT_PANE_ID;

      return { tabs: newTabs, rootPane: newRoot, focusedPaneId };
    });
  },

  pinTab: (tabId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [tabId]: { ...tab, pinned: true } } };
    });
  },

  setActiveTab: (paneId, tabId) => {
    set((state) => ({
      rootPane: updateLeaf(state.rootPane, paneId, (l) => ({ ...l, activeTabId: tabId })),
      focusedPaneId: paneId,
    }));
  },

  setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

  reorderTab: (paneId, fromIdx, toIdx) => {
    set((state) => ({
      rootPane: updateLeaf(state.rootPane, paneId, (l) => {
        const ids = [...l.tabIds];
        const [moved] = ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, moved);
        return { ...l, tabIds: ids };
      }),
    }));
  },

  moveTab: (tabId, fromPaneId, toPaneId, index) => {
    set((state) => {
      // Remove from source pane
      let newRoot = updateLeaf(state.rootPane, fromPaneId, (l) => {
        const remaining = l.tabIds.filter((id) => id !== tabId);
        const newActive =
          l.activeTabId === tabId
            ? remaining.length > 0
              ? remaining[remaining.length - 1]
              : null
            : l.activeTabId;
        return { ...l, tabIds: remaining, activeTabId: newActive };
      });

      // Add to target pane
      newRoot = updateLeaf(newRoot, toPaneId, (l) => {
        const ids = [...l.tabIds];
        if (index !== undefined && index >= 0) {
          ids.splice(index, 0, tabId);
        } else {
          ids.push(tabId);
        }
        return { ...l, tabIds: ids, activeTabId: tabId };
      });

      // Collapse empty panes
      newRoot = collapsePaneTree(newRoot);

      // Ensure root is at least an empty leaf
      if (newRoot.type === "leaf" && newRoot.tabIds.length === 0 && allLeafIds(newRoot).length === 0) {
        newRoot = makeLeaf(ROOT_PANE_ID);
      }

      const leafIds = allLeafIds(newRoot);
      const focusedPaneId = leafIds.includes(toPaneId) ? toPaneId : leafIds[0] ?? ROOT_PANE_ID;

      return { rootPane: newRoot, focusedPaneId };
    });
  },

  splitPane: (paneId, direction, tabId) => {
    set((state) => {
      const leaf = findLeaf(state.rootPane, paneId);
      if (!leaf) return state;

      // Remove tab from the original pane
      const remainingTabIds = leaf.tabIds.filter((id) => id !== tabId);
      const originalActive =
        leaf.activeTabId === tabId
          ? remainingTabIds.length > 0
            ? remainingTabIds[remainingTabIds.length - 1]
            : null
          : leaf.activeTabId;

      const originalLeaf: PaneNode = {
        type: "leaf",
        id: leaf.id,
        tabIds: remainingTabIds,
        activeTabId: originalActive,
      };

      const newLeafId = crypto.randomUUID();
      const newLeaf: PaneNode = {
        type: "leaf",
        id: newLeafId,
        tabIds: [tabId],
        activeTabId: tabId,
      };

      // For left/top splits, new pane goes first; for right/bottom, second
      // By convention, splitPane is called with the direction and the new pane
      // goes to the "second" child (right or bottom)
      const splitNode: PaneNode = {
        type: "split",
        id: crypto.randomUUID(),
        direction,
        children: [originalLeaf, newLeaf],
        ratio: 0.5,
      };

      const newRoot = replaceNode(state.rootPane, paneId, splitNode);

      return { rootPane: newRoot, focusedPaneId: newLeafId };
    });
  },

  setSplitRatio: (splitPaneId, ratio) => {
    set((state) => {
      function updateSplit(node: PaneNode): PaneNode {
        if (node.type === "leaf") return node;
        if (node.id === splitPaneId) {
          return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
        }
        return {
          ...node,
          children: [updateSplit(node.children[0]), updateSplit(node.children[1])] as [PaneNode, PaneNode],
        };
      }
      return { rootPane: updateSplit(state.rootPane) };
    });
  },

  getTabsForPane: (paneId) => {
    const state = get();
    const leaf = findLeaf(state.rootPane, paneId);
    if (!leaf) return [];
    return leaf.tabIds.map((id) => state.tabs[id]).filter(Boolean);
  },

  findPaneForTab: (tabId) => {
    return findPaneContainingTab(get().rootPane, tabId);
  },
}));
