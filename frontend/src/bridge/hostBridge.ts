import { PAGES_ORIGIN, PREVIEW_WIDTH } from "../config";
import { zoomAtClient } from "../board/camera";
import { handleShortcut } from "../keyboard";
import { createStore } from "../lib/store";
import { wheelDeltaToPixels } from "../lib/dom";
import { modeStore, type Mode } from "../modes";

// Messages exchanged with public/agent.js; see the protocol comment at the top of that file.
type AgentMessage =
  | { source: "figr-agent"; session: string; type: "hello"; url: string }
  | { source: "figr-agent"; session: string; type: "zoom"; x: number; y: number; deltaY: number; deltaMode: number }
  | { source: "figr-agent"; session: string; type: "key"; key: string; shiftKey: boolean };

type HostMessage = { type: "init"; mode: Mode } | { type: "mode"; mode: Mode };

type Peer = {
  screenId: string;
  iframe: HTMLIFrameElement;
  /** Changes every time the page (re)loads; messages from any other session are stale. */
  session: string | null;
  url: string | null;
};

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

export function registerPreview(screenId: string, iframe: HTMLIFrameElement): () => void {
  const peer: Peer = { screenId, iframe, session: null, url: null };
  peers.set(screenId, peer);
  setStatus(screenId, "connecting");
  return () => {
    if (peers.get(screenId) !== peer) return;
    peers.delete(screenId);
    setStatus(screenId, null);
  };
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

  if (msg.type === "hello") {
    // A new session on a known iframe means the page navigated or reloaded.
    peer.session = msg.session;
    peer.url = msg.url;
    post(peer, { type: "init", mode: modeStore.get() });
    setStatus(peer.screenId, "connected");
    return;
  }

  if (msg.session !== peer.session) return;

  switch (msg.type) {
    case "zoom": {
      const rect = peer.iframe.getBoundingClientRect();
      const scale = rect.width / PREVIEW_WIDTH;
      const deltaPx = wheelDeltaToPixels(msg.deltaY, msg.deltaMode, window.innerHeight);
      zoomAtClient(rect.left + msg.x * scale, rect.top + msg.y * scale, deltaPx);
      break;
    }
    case "key":
      handleShortcut({ key: msg.key, shiftKey: msg.shiftKey });
      break;
  }
}

let installed = false;
export function installHostBridge() {
  if (installed) return;
  installed = true;
  window.addEventListener("message", onMessage);
  modeStore.subscribe(() => {
    const mode = modeStore.get();
    for (const peer of peers.values()) {
      if (peer.session) post(peer, { type: "mode", mode });
    }
  });
}
