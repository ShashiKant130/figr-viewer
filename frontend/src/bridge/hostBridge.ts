import { PAGES_ORIGIN, PREVIEW_WIDTH } from "../config";
import { onCameraMotion, zoomAtClient } from "../board/camera";
import { createStore } from "../lib/store";
import { wheelDeltaToPixels } from "../lib/dom";
import { modeStore, type Mode } from "../modes";
import { hoverStore, type PageRect } from "../overlay/hoverStore";
import {
  EMPTY_SELECTION,
  selectionStore,
  type SelectedElement,
  type Selection,
} from "../overlay/selectionStore";
import { isLiveProps, liveStore, type LiveProps } from "../inspector/liveStore";
import { failRegion, previewRegion, reportOnce } from "../failures/regions";
import { blockedHellos, takeFault } from "../failures/devFaults";

/** A preview whose page hasn't said hello this long after loading (or leaving) has failed. */
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_PAGE_ERRORS = 20;

type AgentEnvelope = { source: "figr-agent"; session: string };

// Messages exchanged with public/agent.js; see the protocol comment at the top of that file.
type AgentMessage = AgentEnvelope &
  (
    | { type: "hello"; url: string }
    | { type: "leaving" }
    | { type: "pageError"; message: unknown }
    | { type: "zoom"; x: number; y: number; deltaY: number; deltaMode: number }
    | { type: "key"; key: string; shiftKey: boolean }
    | { type: "hover"; epoch: number; target: unknown }
    | { type: "pick"; seq: number; shiftKey: boolean; target: unknown }
    | { type: "navigated"; seq: number; from: string; target: unknown }
    | { type: "selectionRects"; rects: Record<string, unknown> }
    | { type: "selectionRemoved"; ids: unknown[] }
    | { type: "selectionProps"; props: Record<string, unknown> }
    | TreeMessage
  );

/** Layers-tree traffic, validated by the layers module rather than here. */
export type TreeMessage = {
  type: "childrenResult" | "revealResult" | "searchResult" | "treeUpdate";
  [field: string]: unknown;
};

const TREE_MESSAGE_TYPES = new Set(["childrenResult", "revealResult", "searchResult", "treeUpdate"]);

export type NavigateDirection = "firstChild" | "parent" | "next" | "prev";

export type HostMessage =
  | { type: "init"; mode: Mode; hoverEpoch: number }
  | { type: "mode"; mode: Mode }
  | { type: "clearHover"; epoch: number }
  | { type: "selection"; ids: string[]; seq: number }
  | { type: "navigate"; from: string; direction: NavigateDirection }
  | { type: "children"; req: number; id: string }
  | { type: "reveal"; req: number; id: string }
  | { type: "search"; req: number; query: string }
  | { type: "hoverNode"; id: string | null }
  | { type: "pickId"; id: string; shiftKey: boolean };

type TreeHandlers = {
  onMessage(screenId: string, message: TreeMessage): void;
  /** The preview's page (re)loaded; ids from before mean nothing now. */
  onSession(screenId: string): void;
};

let treeHandlers: TreeHandlers | null = null;
export function setTreeHandlers(handlers: TreeHandlers) {
  treeHandlers = handlers;
}

/** Returns false if the preview's page isn't connected. */
export function sendToPreview(screenId: string, message: HostMessage): boolean {
  const peer = peers.get(screenId);
  if (!peer?.session) return false;
  post(peer, message);
  return true;
}

type Peer = {
  screenId: string;
  iframe: HTMLIFrameElement;
  /** Changes every time the page (re)loads; messages from any other session are stale. */
  session: string | null;
  url: string | null;
  /** Bumped on every host-side hover clear; hover messages stamped with an older epoch are stale. */
  hoverEpoch: number;
  /** Highest pick/navigate seq seen from the agent; echoed so it knows which ids it may forget. */
  agentSeq: number;
  /** Running while waiting for a hello; firing fails the preview. */
  connectTimer: number;
};

export type ShortcutHandler = (key: { key: string; shiftKey: boolean }) => void;

export type PeerStatus = "connecting" | "connected";

const peers = new Map<string, Peer>();
export const peerStatusStore = createStore<Record<string, PeerStatus>>({});

function setStatus(screenId: string, status: PeerStatus | null) {
  peerStatusStore.set((prev) => {
    if (status === null) {
      if (!(screenId in prev)) return prev;
      const { [screenId]: _removed, ...rest } = prev;
      return rest;
    }
    return prev[screenId] === status ? prev : { ...prev, [screenId]: status };
  });
}

/** Uncaught errors reported by each preview's page, newest last. Cleared when the page reloads. */
export const pageErrorStore = createStore<Record<string, string[]>>({});

export function registerPreview(screenId: string, iframe: HTMLIFrameElement): () => void {
  const peer: Peer = {
    screenId,
    iframe,
    session: null,
    url: null,
    hoverEpoch: 0,
    agentSeq: 0,
    connectTimer: 0,
  };
  peers.set(screenId, peer);
  setStatus(screenId, "connecting");
  startConnectTimer(peer);
  return () => {
    window.clearTimeout(peer.connectTimer);
    if (peers.get(screenId) !== peer) return;
    peers.delete(screenId);
    setStatus(screenId, null);
    dropHoverFor(screenId);
    dropLiveFor(screenId);
    dropPageErrorsFor(screenId);
    if (selectionStore.get().screenId === screenId) selectionStore.set(EMPTY_SELECTION);
  };
}

function startConnectTimer(peer: Peer) {
  window.clearTimeout(peer.connectTimer);
  peer.connectTimer = window.setTimeout(() => {
    blockedHellos.delete(peer.screenId);
    // A preview that was removed meanwhile has no region left to fail; failRegion ignores it.
    failRegion(
      previewRegion(peer.screenId),
      new Error(`The page didn't respond within ${CONNECT_TIMEOUT_MS / 1000} seconds`),
      { region: "preview", screenId: peer.screenId },
      { title: "Couldn't connect to this preview" },
    );
  }, CONNECT_TIMEOUT_MS);
}

/** Dev only: reloads a preview and ignores its page's hello, so it fails to connect. */
export function breakPreviewConnection(screenId: string) {
  const peer = peers.get(screenId);
  if (!peer) return;
  blockedHellos.add(screenId);
  peer.session = null;
  setStatus(screenId, "connecting");
  startConnectTimer(peer);
  peer.iframe.src = peer.iframe.src;
}

function dropPageErrorsFor(screenId: string) {
  pageErrorStore.set((prev) => {
    if (!(screenId in prev)) return prev;
    const { [screenId]: _dropped, ...rest } = prev;
    return rest;
  });
}

function dropHoverFor(screenId: string) {
  if (hoverStore.get()?.screenId === screenId) hoverStore.set(null);
}

/** Clears the board's hover and tells the page it came from to stay quiet until the next move. */
export function clearHover() {
  const hover = hoverStore.get();
  if (!hover) return;
  hoverStore.set(null);
  const peer = peers.get(hover.screenId);
  if (peer?.session) post(peer, { type: "clearHover", epoch: ++peer.hoverEpoch });
}

function post(peer: Peer, message: HostMessage) {
  peer.iframe.contentWindow?.postMessage({ source: "figr-host", ...message }, PAGES_ORIGIN);
}

function findPeer(source: MessageEventSource | null): Peer | undefined {
  if (!source) return undefined;
  for (const peer of peers.values()) {
    if (peer.iframe.contentWindow === source) return peer;
  }
  return undefined;
}

function isAgentMessage(data: unknown): data is AgentMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "figr-agent" &&
    typeof (data as { session?: unknown }).session === "string" &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

function onMessage(event: MessageEvent) {
  if (event.origin !== PAGES_ORIGIN || !isAgentMessage(event.data)) return;
  const peer = findPeer(event.source);
  if (!peer) return;
  const msg = event.data;
  // A throw while handling one preview's message fails only the region the message feeds.
  try {
    if (takeFault("message")) throw new Error("Dev: error while handling a message from a preview");
    handleMessage(peer, msg);
  } catch (error) {
    if (TREE_MESSAGE_TYPES.has(msg.type)) {
      failRegion("layers", error, { region: "layers", screenId: peer.screenId });
    } else {
      failRegion(previewRegion(peer.screenId), error, { region: "preview", screenId: peer.screenId });
    }
  }
}

function handleMessage(peer: Peer, msg: AgentMessage) {
  if (msg.type === "hello") {
    if (blockedHellos.has(peer.screenId)) return;
    window.clearTimeout(peer.connectTimer);
    dropPageErrorsFor(peer.screenId);
    // A new session on a known iframe means the page navigated or reloaded.
    peer.session = msg.session;
    peer.url = msg.url;
    peer.agentSeq = 0;
    dropHoverFor(peer.screenId);
    dropLiveFor(peer.screenId);
    // Ids from the previous page mean nothing to the new one; the preview stays active.
    selectionStore.set((prev) =>
      prev.screenId === peer.screenId && (prev.ids.length > 0 || prev.lost)
        ? { ...EMPTY_SELECTION, screenId: peer.screenId }
        : prev,
    );
    post(peer, { type: "init", mode: modeStore.get(), hoverEpoch: peer.hoverEpoch });
    setStatus(peer.screenId, "connected");
    treeHandlers?.onSession(peer.screenId);
    return;
  }

  if (msg.session !== peer.session) return;

  if (msg.type === "leaving") {
    // The next page has CONNECT_TIMEOUT_MS to say hello, or this preview has failed.
    setStatus(peer.screenId, "connecting");
    startConnectTimer(peer);
    return;
  }

  if (msg.type === "pageError") {
    const message = typeof msg.message === "string" ? msg.message : "Unknown error";
    pageErrorStore.set((prev) => ({
      ...prev,
      [peer.screenId]: [...(prev[peer.screenId] ?? []), message].slice(-MAX_PAGE_ERRORS),
    }));
    reportOnce(new Error(`Page error: ${message}`), { region: "preview", screenId: peer.screenId });
    return;
  }

  if (TREE_MESSAGE_TYPES.has(msg.type)) {
    const tree = msg as TreeMessage;
    if (tree.type === "treeUpdate" && Array.isArray(tree.removed)) {
      const hover = hoverStore.get();
      if (hover?.screenId === peer.screenId && tree.removed.includes(hover.id)) hoverStore.set(null);
    }
    treeHandlers?.onMessage(peer.screenId, tree);
    return;
  }

  switch (msg.type) {
    case "zoom": {
      const rect = peer.iframe.getBoundingClientRect();
      const scale = rect.width / PREVIEW_WIDTH;
      const deltaPx = wheelDeltaToPixels(msg.deltaY, msg.deltaMode, window.innerHeight);
      zoomAtClient(rect.left + msg.x * scale, rect.top + msg.y * scale, deltaPx);
      break;
    }
    case "key":
      if (typeof msg.key === "string") onKey?.({ key: msg.key, shiftKey: msg.shiftKey === true });
      break;
    case "hover":
      onHover(peer, msg.epoch, msg.target);
      break;
    case "pick":
      onPick(peer, msg.seq, msg.shiftKey === true, msg.target);
      break;
    case "navigated":
      onNavigated(peer, msg.seq, msg.from, msg.target);
      break;
    case "selectionRects":
      onSelectionRects(peer, msg.rects);
      break;
    case "selectionRemoved":
      if (Array.isArray(msg.ids)) onSelectionRemoved(peer, msg.ids);
      break;
    case "selectionProps":
      onSelectionProps(peer, msg.props);
      break;
  }
}

// ---- Live inspector values -------------------------------------------------------

// Not filtered by the current selection: the agent sends an element's values just before the
// pick that selects it.
function onSelectionProps(peer: Peer, props: Record<string, unknown>) {
  if (typeof props !== "object" || props === null) return;
  const valid: Record<string, LiveProps> = {};
  let any = false;
  for (const [id, value] of Object.entries(props)) {
    if (!isLiveProps(value)) continue;
    valid[id] = value;
    any = true;
  }
  if (!any) return;
  liveStore.set((prev) => ({ ...prev, [peer.screenId]: { ...prev[peer.screenId], ...valid } }));
}

function dropLiveFor(screenId: string) {
  liveStore.set((prev) => {
    if (!(screenId in prev)) return prev;
    const { [screenId]: _dropped, ...rest } = prev;
    return rest;
  });
}

function isPageRect(value: unknown): value is PageRect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n));
}

function onHover(peer: Peer, epoch: number, target: unknown) {
  if (epoch !== peer.hoverEpoch || modeStore.get() !== "select") return;
  if (target === null) {
    dropHoverFor(peer.screenId);
    return;
  }
  const t = parseTarget(target);
  const path = (target as { path?: unknown }).path;
  if (!t || !Array.isArray(path) || !path.every((id) => typeof id === "string")) return;
  // Replacing the store value is what keeps a single hover across the whole board.
  hoverStore.set({ screenId: peer.screenId, id: t.id, path, name: t.name, rect: t.rect });
}

// ---- Selection ---------------------------------------------------------------

function parseTarget(value: unknown): SelectedElement | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.id !== "string" || typeof t.name !== "string" || !isPageRect(t.rect)) return null;
  return { id: t.id, name: t.name, rect: t.rect };
}

function noteSeq(peer: Peer, seq: unknown) {
  if (typeof seq === "number" && seq > peer.agentSeq) peer.agentSeq = seq;
}

/** Replaces the selection and tells the affected pages which of their ids are still selected. */
function setSelection(next: Selection) {
  const prev = selectionStore.get();
  selectionStore.set(next);
  const notify = new Set([prev.screenId, next.screenId]);
  for (const screenId of notify) {
    const peer = screenId ? peers.get(screenId) : undefined;
    if (!peer?.session) continue;
    const ids = next.screenId === screenId ? next.ids : [];
    post(peer, { type: "selection", ids, seq: peer.agentSeq });
  }
}

function selectOnly(screenId: string, element: SelectedElement): Selection {
  return { screenId, ids: [element.id], elements: { [element.id]: element }, lost: false };
}

function onPick(peer: Peer, seq: number, shiftKey: boolean, rawTarget: unknown) {
  noteSeq(peer, seq);
  if (modeStore.get() !== "select") return;
  const prev = selectionStore.get();
  const target = parseTarget(rawTarget);

  if (!target) {
    setSelection({ ...EMPTY_SELECTION, screenId: peer.screenId });
    return;
  }
  if (!shiftKey || prev.screenId !== peer.screenId) {
    setSelection(selectOnly(peer.screenId, target));
    return;
  }
  if (prev.ids.includes(target.id)) {
    const { [target.id]: _removed, ...elements } = prev.elements;
    setSelection({ ...prev, ids: prev.ids.filter((id) => id !== target.id), elements, lost: false });
  } else {
    setSelection({
      ...prev,
      ids: [...prev.ids, target.id],
      elements: { ...prev.elements, [target.id]: target },
      lost: false,
    });
  }
}

function onNavigated(peer: Peer, seq: number, from: unknown, rawTarget: unknown) {
  noteSeq(peer, seq);
  const prev = selectionStore.get();
  // Stale if the selection changed while the page was answering.
  if (prev.screenId !== peer.screenId || prev.ids[prev.ids.length - 1] !== from) {
    setSelection(prev);
    return;
  }
  const target = parseTarget(rawTarget);
  setSelection(target ? selectOnly(peer.screenId, target) : prev);
}

function onSelectionRects(peer: Peer, rects: Record<string, unknown>) {
  if (typeof rects !== "object" || rects === null) return;
  selectionStore.set((prev) => {
    if (prev.screenId !== peer.screenId) return prev;
    let elements: Record<string, SelectedElement> | null = null;
    for (const [id, rect] of Object.entries(rects)) {
      const current = prev.elements[id];
      if (!current || !isPageRect(rect)) continue;
      elements ??= { ...prev.elements };
      elements[id] = { ...current, rect };
    }
    return elements ? { ...prev, elements } : prev;
  });
}

function onSelectionRemoved(peer: Peer, ids: unknown[]) {
  const prev = selectionStore.get();
  if (prev.screenId !== peer.screenId) return;
  const gone = new Set(ids.filter((id): id is string => typeof id === "string"));
  const remaining = prev.ids.filter((id) => !gone.has(id));
  if (remaining.length === prev.ids.length) return;
  const elements: Record<string, SelectedElement> = {};
  for (const id of remaining) elements[id] = prev.elements[id];
  setSelection({ ...prev, ids: remaining, elements, lost: remaining.length === 0 });
}

/** Returns false when there was nothing to clear. */
export function clearSelection(): boolean {
  const prev = selectionStore.get();
  if (prev.ids.length === 0 && !prev.lost) return false;
  setSelection({ ...EMPTY_SELECTION, screenId: prev.screenId });
  return true;
}

/** Asks the page to move from the most recently selected element. False if nothing is selected. */
export function navigateSelection(direction: NavigateDirection): boolean {
  const { screenId, ids } = selectionStore.get();
  const peer = screenId ? peers.get(screenId) : undefined;
  const from = ids[ids.length - 1];
  if (!peer?.session || !from) return false;
  post(peer, { type: "navigate", from, direction });
  return true;
}

let onKey: ShortcutHandler | null = null;
let installed = false;
export function installHostBridge(options: { onKey: ShortcutHandler }) {
  if (installed) return;
  installed = true;
  onKey = options.onKey;
  window.addEventListener("message", onMessage);
  modeStore.subscribe(() => {
    const mode = modeStore.get();
    clearHover();
    for (const peer of peers.values()) {
      if (peer.session) post(peer, { type: "mode", mode });
    }
  });
  onCameraMotion(clearHover);
}
