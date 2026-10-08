import { sendToPreview, setTreeHandlers, type TreeMessage } from "../bridge/hostBridge";
import { modeStore } from "../modes";
import { selectionStore } from "../overlay/selectionStore";
import {
  EMPTY_TREE,
  ROOT,
  layersStore,
  type ChildList,
  type PreviewTree,
  type SearchResults,
  type TreeNode,
} from "./layersStore";

const LOAD_TIMEOUT_MS = 3000;
const SEARCH_DEBOUNCE_MS = 150;

let nextReq = 0;
let revealSeq = 0;
/** Panel scroll offsets per preview; not reactive, read when a preview's panel mounts. */
const scrollTops = new Map<string, number>();
const pendingReveal = new Map<string, number>();
const searchTimers = new Map<string, number>();

function update(screenId: string, fn: (tree: PreviewTree) => PreviewTree) {
  layersStore.set((prev) => {
    const tree = prev[screenId] ?? EMPTY_TREE;
    const next = fn(tree);
    return next === tree && prev[screenId] ? prev : { ...prev, [screenId]: next };
  });
}

// ---- Parsing -----------------------------------------------------------------

function parseNodes(value: unknown): TreeNode[] | null {
  if (!Array.isArray(value)) return null;
  const out: TreeNode[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== "string" || typeof n.name !== "string" || typeof n.hasChildren !== "boolean") {
      return null;
    }
    out.push({ id: n.id, name: n.name, hasChildren: n.hasChildren });
  }
  return out;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Replaces a parent's children (never appends), so repeated answers can't duplicate rows. */
function withList(tree: PreviewTree, key: string, children: TreeNode[], req: number): PreviewTree {
  const nodes = { ...tree.nodes };
  const parentOf = { ...tree.parentOf };
  for (const child of children) {
    nodes[child.id] = child;
    parentOf[child.id] = key;
  }
  const list: ChildList = { status: "ready", ids: children.map((c) => c.id), req };
  return { ...tree, nodes, parentOf, lists: { ...tree.lists, [key]: list } };
}

// ---- Loading -------------------------------------------------------------------

function requestChildren(screenId: string, key: string) {
  const req = ++nextReq;
  update(screenId, (tree) => ({
    ...tree,
    lists: { ...tree.lists, [key]: { status: "loading", ids: [], req } },
  }));
  sendToPreview(screenId, { type: "children", req, id: key });
  window.setTimeout(() => {
    update(screenId, (tree) => {
      const list = tree.lists[key];
      if (!list || list.req !== req || list.status !== "loading") return tree;
      return { ...tree, lists: { ...tree.lists, [key]: { ...list, status: "error" } } };
    });
  }, LOAD_TIMEOUT_MS);
}

export function ensureLoaded(screenId: string) {
  if (!layersStore.get()[screenId]?.lists[ROOT]) requestChildren(screenId, ROOT);
}

export function retry(screenId: string, key: string) {
  requestChildren(screenId, key);
}

export function setExpanded(screenId: string, id: string, open: boolean) {
  const tree = layersStore.get()[screenId] ?? EMPTY_TREE;
  if (Boolean(tree.expanded[id]) === open) return;
  update(screenId, (t) => {
    const expanded = { ...t.expanded };
    if (open) expanded[id] = true;
    else delete expanded[id];
    return { ...t, expanded };
  });
  // A load already in flight is reused, so collapse + re-expand never asks twice.
  const list = tree.lists[id];
  if (open && (!list || list.status === "error")) requestChildren(screenId, id);
}

export function toggleExpanded(screenId: string, id: string) {
  setExpanded(screenId, id, !layersStore.get()[screenId]?.expanded[id]);
}

// ---- Rows <-> page -------------------------------------------------------------

export function hoverRow(screenId: string, id: string | null) {
  if (modeStore.get() !== "select") return;
  sendToPreview(screenId, { type: "hoverNode", id });
}

export function pickRow(screenId: string, id: string, shiftKey: boolean) {
  sendToPreview(screenId, { type: "pickId", id, shiftKey });
}

function reveal(screenId: string, id: string) {
  const tree = layersStore.get()[screenId];
  if (tree?.search) {
    // Expanding would change the state that clearing the search must restore; just scroll.
    update(screenId, (t) => ({ ...t, reveal: { id, seq: ++revealSeq } }));
    return;
  }
  const req = ++nextReq;
  pendingReveal.set(screenId, req);
  sendToPreview(screenId, { type: "reveal", req, id });
}

export function saveScrollTop(screenId: string, top: number) {
  scrollTops.set(screenId, top);
}

export function savedScrollTop(screenId: string): number {
  return scrollTops.get(screenId) ?? 0;
}

// ---- Search ----------------------------------------------------------------------

export function setSearch(screenId: string, query: string) {
  window.clearTimeout(searchTimers.get(screenId));
  if (query === "") {
    update(screenId, (t) => (t.search ? { ...t, search: null } : t));
    return;
  }
  update(screenId, (t) => ({
    ...t,
    search: {
      query,
      status: "loading",
      req: t.search?.req ?? 0,
      results: t.search?.results ?? null,
    },
  }));
  scheduleSearch(screenId);
}

function scheduleSearch(screenId: string) {
  window.clearTimeout(searchTimers.get(screenId));
  searchTimers.set(screenId, window.setTimeout(() => runSearch(screenId), SEARCH_DEBOUNCE_MS));
}

function runSearch(screenId: string) {
  const search = layersStore.get()[screenId]?.search;
  if (!search) return;
  const req = ++nextReq;
  update(screenId, (t) => (t.search ? { ...t, search: { ...t.search, req } } : t));
  sendToPreview(screenId, { type: "search", req, query: search.query });
  window.setTimeout(() => {
    update(screenId, (t) =>
      t.search?.req === req && t.search.status === "loading"
        ? { ...t, search: { ...t.search, status: "error" } }
        : t,
    );
  }, LOAD_TIMEOUT_MS);
}

// ---- Messages from the page --------------------------------------------------------

function onChildren(screenId: string, msg: TreeMessage) {
  const { id: key, req } = msg;
  if (typeof key !== "string") return;
  update(screenId, (tree) => {
    const list = tree.lists[key];
    if (!list || list.req !== req) return tree;
    const children = parseNodes(msg.nodes);
    if (!children) return { ...tree, lists: { ...tree.lists, [key]: { ...list, status: "error" } } };
    return withList(tree, key, children, list.req);
  });
}

function onReveal(screenId: string, msg: TreeMessage) {
  if (pendingReveal.get(screenId) !== msg.req) return;
  pendingReveal.delete(screenId);
  const { id, path, lists } = msg;
  if (typeof id !== "string" || !isStringArray(path) || typeof lists !== "object" || !lists) return;
  update(screenId, (tree) => {
    let next = tree;
    for (const [key, raw] of Object.entries(lists as Record<string, unknown>)) {
      const children = parseNodes(raw);
      if (children) next = withList(next, key, children, next.lists[key]?.req ?? 0);
    }
    const expanded = { ...next.expanded };
    for (const ancestor of path.slice(0, -1)) expanded[ancestor] = true;
    return { ...next, expanded, reveal: { id, seq: ++revealSeq } };
  });
}

function onSearchResult(screenId: string, msg: TreeMessage) {
  const tree = layersStore.get()[screenId];
  if (!tree?.search || tree.search.req !== msg.req || !Array.isArray(msg.nodes)) return;
  const raw = msg.nodes as Array<Record<string, unknown>>;
  const found = parseNodes(raw);
  if (!found || !isStringArray(msg.matches)) return;

  const nodes = { ...tree.nodes };
  const parentOf = { ...tree.parentOf };
  const children: SearchResults["children"] = {};
  found.forEach((node, i) => {
    const parent = typeof raw[i].parent === "string" ? (raw[i].parent as string) : ROOT;
    nodes[node.id] = node;
    parentOf[node.id] = parent;
    (children[parent] ??= []).push(node.id);
  });
  const matches: SearchResults["matches"] = {};
  for (const id of msg.matches) matches[id] = true;

  update(screenId, (t) => {
    if (!t.search || t.search.req !== msg.req) return t;
    const results = { children, matches, truncated: msg.truncated === true };
    return { ...t, nodes, parentOf, search: { ...t.search, status: "ready", results } };
  });
}

function onTreeUpdate(screenId: string, msg: TreeMessage) {
  const removed = isStringArray(msg.removed) ? msg.removed : [];
  const changed = Array.isArray(msg.changed) ? (msg.changed as Array<Record<string, unknown>>) : [];

  update(screenId, (tree) => {
    let next = tree;
    for (const change of changed) {
      const id = change.id;
      if (typeof id !== "string") continue;
      const node = next.nodes[id];
      if (node && typeof change.hasChildren === "boolean" && node.hasChildren !== change.hasChildren) {
        next = { ...next, nodes: { ...next.nodes, [id]: { ...node, hasChildren: change.hasChildren } } };
      }
      const children = parseNodes(change.children);
      if (children) next = withList(next, id, children, next.lists[id]?.req ?? 0);
    }
    if (removed.length === 0) return next;

    const nodes = { ...next.nodes };
    const parentOf = { ...next.parentOf };
    const lists = { ...next.lists };
    const expanded = { ...next.expanded };
    const gone = new Set(removed);
    const touchedParents = new Set<string>();
    for (const id of removed) {
      if (parentOf[id]) touchedParents.add(parentOf[id]);
      delete nodes[id];
      delete parentOf[id];
      delete lists[id];
      delete expanded[id];
    }
    for (const parent of touchedParents) {
      const list = lists[parent];
      if (list) lists[parent] = { ...list, ids: list.ids.filter((id) => !gone.has(id)) };
    }
    return { ...next, nodes, parentOf, lists, expanded };
  });

  if (layersStore.get()[screenId]?.search) scheduleSearch(screenId);
}

function onSession(screenId: string) {
  window.clearTimeout(searchTimers.get(screenId));
  pendingReveal.delete(screenId);
  scrollTops.delete(screenId);
  layersStore.set((prev) => {
    if (!(screenId in prev)) return prev;
    const { [screenId]: _dropped, ...rest } = prev;
    return rest;
  });
  if (selectionStore.get().screenId === screenId) ensureLoaded(screenId);
}

let installed = false;
export function installLayers() {
  if (installed) return;
  installed = true;
  setTreeHandlers({
    onSession,
    onMessage(screenId, msg) {
      switch (msg.type) {
        case "childrenResult":
          return onChildren(screenId, msg);
        case "revealResult":
          return onReveal(screenId, msg);
        case "searchResult":
          return onSearchResult(screenId, msg);
        case "treeUpdate":
          return onTreeUpdate(screenId, msg);
      }
    },
  });

  // A newly selected element (from the preview, a row, or the keyboard) is revealed in the panel.
  // Ids are per page, so the preview is part of the identity.
  let lastSelected = "";
  selectionStore.subscribe(() => {
    const { screenId, ids } = selectionStore.get();
    const last = ids[ids.length - 1];
    const key = screenId && last ? `${screenId}\n${last}` : "";
    if (screenId && last && key !== lastSelected) reveal(screenId, last);
    lastSelected = key;
  });
}
