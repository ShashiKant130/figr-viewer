import { createStore } from "../lib/store";

/** Inspector values read from the page by its agent. Colours are hex; sizes are rounded px. */
export type LiveProps = {
  name: string;
  tag: string;
  elementId: string;
  classes: string[];
  width: number;
  height: number;
  /** Position within the page, in document coordinates. */
  x: number;
  y: number;
  /** First 120 characters, whitespace collapsed. */
  text: string;
  color: string;
  /** The colour actually seen behind the element, ancestors blended in. */
  background: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  /** `data-key`, the lookup key for GET /elements/:key. */
  key: string | null;
};

/** screenId -> element id -> latest values. Written only by the host bridge. */
export const liveStore = createStore<Record<string, Record<string, LiveProps>>>({});

export function isLiveProps(value: unknown): value is LiveProps {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const strings = [p.name, p.tag, p.elementId, p.text, p.color, p.background, p.fontFamily, p.fontSize, p.fontWeight];
  const numbers = [p.width, p.height, p.x, p.y];
  return (
    strings.every((s) => typeof s === "string") &&
    numbers.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Array.isArray(p.classes) &&
    p.classes.every((c) => typeof c === "string") &&
    (p.key === null || typeof p.key === "string")
  );
}
