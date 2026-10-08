import { createStore } from "../lib/store";
import { report } from "../../report.js";

export type ReportRegion = "board" | "preview" | "layers" | "layers-row" | "details" | "inspector";
export type ReportContext = { region: ReportRegion; screenId: string | null; elementKey?: string };

export type RegionFailure = {
  /** Heading for the error, when the failure has a specific meaning ("Couldn't connect…"). */
  title: string | null;
  message: string;
};

/**
 * Region key -> its current failure. A region in here shows its error and Retry instead of its
 * content. Keys: "board", "layers", "inspector", "details", "preview:<screenId>".
 */
export const regionErrorStore = createStore<Record<string, RegionFailure>>({});

export const previewRegion = (screenId: string) => `preview:${screenId}`;

const mountedRegions = new Map<string, number>();
const reportedErrors = new WeakSet<object>();

/** Called by <Region> while it's on screen; failures of regions that are gone are dropped. */
export function mountRegion(key: string): () => void {
  mountedRegions.set(key, (mountedRegions.get(key) ?? 0) + 1);
  return () => {
    const count = (mountedRegions.get(key) ?? 1) - 1;
    if (count > 0) {
      mountedRegions.set(key, count);
      return;
    }
    mountedRegions.delete(key);
    // Deferred so a StrictMode unmount/remount in the same commit doesn't wipe a fresh failure.
    queueMicrotask(() => {
      if (!mountedRegions.has(key)) clearRegion(key);
    });
  };
}

/** Reports an error object at most once, however many paths notice it. */
export function reportOnce(error: unknown, context: ReportContext) {
  if (typeof error === "object" && error !== null) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  report(error, context);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Puts a region into its error state and reports the failure. A region that's already showing an
 * error stays as it is (no second report) until Retry clears it; a region that's no longer on
 * screen ignores the failure entirely. `force` is for render errors, which can surface before the
 * region has finished mounting.
 */
export function failRegion(
  key: string,
  error: unknown,
  context: ReportContext,
  options: { title?: string; force?: boolean } = {},
) {
  if (!options.force && !mountedRegions.has(key)) return;
  if (regionErrorStore.get()[key]) return;
  reportOnce(error, context);
  regionErrorStore.set((prev) => ({
    ...prev,
    [key]: { title: options.title ?? null, message: messageOf(error) },
  }));
}

export function clearRegion(key: string) {
  regionErrorStore.set((prev) => {
    if (!(key in prev)) return prev;
    const { [key]: _cleared, ...rest } = prev;
    return rest;
  });
}

/** Wraps a handler, timer or message callback so anything it throws fails `key` instead. */
export function guard<A extends unknown[]>(
  key: string,
  context: () => ReportContext,
  fn: (...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (error) {
      failRegion(key, error, context());
    }
  };
}
