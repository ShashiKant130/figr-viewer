import { createStore } from "./lib/store";

export type Mode = "select" | "interact";

/** The host owns the mode; every agent is told about it on connect and on change. */
export const modeStore = createStore<Mode>("select");

export function setMode(mode: Mode) {
  modeStore.set(mode);
}
