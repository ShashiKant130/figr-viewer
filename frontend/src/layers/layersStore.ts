import { createStore } from "../lib/store";

/** Parent key of top-level rows (the children of <body>). */
export const ROOT = "root";

export type TreeNode = { id: string; name: string; hasChildren: boolean };

export type ChildList = {
  status: "loading" | "error" | "ready";
  ids: string[];
  /** The request this list is waiting for; answers to any other request are stale. */
  req: number;
};

export type SearchResults = {
  /** Parent key -> child ids, in document order: every match plus its ancestors. */
  children: Record<string, string[]>;
  matches: Record<string, true>;
  truncated: boolean;
};

export type SearchState = {
  query: string;
  status: "loading" | "ready" | "error";
  req: number;
  /** Kept while a newer query loads, so the list doesn't flash empty. */
  results: SearchResults | null;
};

/** Everything the layers panel remembers about one preview's page. */
export type PreviewTree = {
  nodes: Record<string, TreeNode>;
  parentOf: Record<string, string>;
  lists: Record<string, ChildList>;
  expanded: Record<string, true>;
  search: SearchState | null;
  /** Bumped when the panel should scroll `id` into view. */
  reveal: { id: string; seq: number } | null;
};

export const EMPTY_TREE: PreviewTree = {
  nodes: {},
  parentOf: {},
  lists: {},
  expanded: {},
  search: null,
  reveal: null,
};

/** Keyed by screen id. Written only by the layers controller. */
export const layersStore = createStore<Record<string, PreviewTree>>({});

export type Row =
  | { kind: "node"; id: string; depth: number; parent: string }
  | { kind: "loading"; key: string; depth: number }
  | { kind: "error"; key: string; depth: number }
  | { kind: "message"; text: string }
  | { kind: "searchError" };

/** The rows on screen, top to bottom: the normal tree, or the search results while searching. */
export function visibleRows(tree: PreviewTree): Row[] {
  const rows: Row[] = [];
  const search = tree.search;

  if (search) {
    const results = search.results;
    if (search.status === "error") {
      rows.push({ kind: "searchError" });
      return rows;
    }
    if (!results) {
      rows.push({ kind: "message", text: "Searching…" });
      return rows;
    }
    const walk = (key: string, depth: number) => {
      for (const id of results.children[key] ?? []) {
        if (!tree.nodes[id]) continue;
        rows.push({ kind: "node", id, depth, parent: key });
        walk(id, depth + 1);
      }
    };
    walk(ROOT, 0);
    if (rows.length === 0) rows.push({ kind: "message", text: "No matches" });
    return rows;
  }

  const walk = (key: string, depth: number) => {
    const list = tree.lists[key];
    if (!list || (list.status === "loading" && list.ids.length === 0)) {
      rows.push({ kind: "loading", key, depth });
      return;
    }
    if (list.status === "error") {
      rows.push({ kind: "error", key, depth });
      return;
    }
    for (const id of list.ids) {
      const node = tree.nodes[id];
      if (!node) continue;
      rows.push({ kind: "node", id, depth, parent: key });
      if (node.hasChildren && tree.expanded[id]) walk(id, depth + 1);
    }
  };
  walk(ROOT, 0);
  return rows;
}
