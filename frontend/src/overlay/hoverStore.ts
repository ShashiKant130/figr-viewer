import { createStore } from "../lib/store";

/** In the preview page's own CSS px, relative to its viewport (the iframe's content box). */
export type PageRect = { x: number; y: number; width: number; height: number };

export type Hover = { screenId: string; name: string; rect: PageRect };

/** One hover for the whole board. Written only by the host bridge. */
export const hoverStore = createStore<Hover | null>(null);
