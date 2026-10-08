import { createStore, useStore } from "../lib/store";

/** One-shot failures the dev menu arms; each is consumed by the first code path that hits it. */
export type Fault =
  | "screens"
  | "details"
  | "detailsResponse"
  | "children"
  | "layersClick"
  | "message";

const armed = new Set<Fault>();

export function armFault(fault: Fault) {
  if (import.meta.env.DEV) armed.add(fault);
}

export function takeFault(fault: Fault): boolean {
  return import.meta.env.DEV && armed.delete(fault);
}

/** Bumped to make the board or the Details section fetch again right away. */
export const devReloadStore = createStore({ screens: 0, details: 0 });

export function devReload(what: "screens" | "details") {
  devReloadStore.set((prev) => ({ ...prev, [what]: prev[what] + 1 }));
}

/** Previews whose page's hello is ignored until their connect timeout fires. */
export const blockedHellos = new Set<string>();

/**
 * Region keys whose content throws while rendering. Cleared by the region's Retry, not by the
 * throw itself: React re-renders once after a render error, and a fault that cleared itself on the
 * first throw would quietly succeed on that second render.
 */
const renderFaultStore = createStore<Record<string, true>>({});

export function armRenderFault(region: string) {
  if (import.meta.env.DEV) renderFaultStore.set((prev) => ({ ...prev, [region]: true }));
}

export function disarmRenderFault(region: string) {
  renderFaultStore.set((prev) => {
    if (!(region in prev)) return prev;
    const { [region]: _disarmed, ...rest } = prev;
    return rest;
  });
}

export function RenderFault({ region }: { region: string }) {
  const isArmed = useStore(renderFaultStore, (s) => Boolean(s[region]));
  if (isArmed) throw new Error(`Dev: render error in ${region}`);
  return null;
}
