import { createStore } from "../lib/store";
import type { PageRect } from "./hoverStore";

/** `id` is issued by the page's agent and only means something within that page load. */
export type SelectedElement = { id: string; name: string; rect: PageRect };

export type Selection = {
  /** The preview last clicked in Select mode; the selection always lives in this preview. */
  screenId: string | null;
  /** In selection order; the last one is the most recently selected. */
  ids: string[];
  elements: Record<string, SelectedElement>;
  /** Everything that was selected stopped existing; cleared by the next selection change. */
  lost: boolean;
};

export const EMPTY_SELECTION: Selection = { screenId: null, ids: [], elements: {}, lost: false };

/** Written only by the host bridge. */
export const selectionStore = createStore<Selection>(EMPTY_SELECTION);
