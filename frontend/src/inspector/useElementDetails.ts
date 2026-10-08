import { useCallback, useEffect, useRef, useState } from "react";
import { fetchElementDetails, type ElementDetails } from "../api";
import { devReloadStore, takeFault } from "../failures/devFaults";
import { useRegionFail } from "../failures/Region";
import { reportOnce } from "../failures/regions";
import { useStore } from "../lib/store";

export type DetailsState =
  | { status: "loading" }
  /** The API has no details for this key (404). Not an error. */
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; details: ElementDetails };

type Result = { key: string; attempt: number; reload: number; state: DetailsState };

const LOADING: DetailsState = { status: "loading" };

/**
 * Details for one `data-key`. Changing the key or unmounting aborts the request in flight, and a
 * result is only shown for the key and attempt it was fetched for, so a slow answer for an older
 * selection can never appear. Aborted requests are not failures: nothing is shown or reported.
 */
export function useElementDetails(key: string | null, screenId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const devReload = useStore(devReloadStore, (s) => s.details);
  const failRegion = useRegionFail();
  const screenIdRef = useRef(screenId);
  useEffect(() => {
    screenIdRef.current = screenId;
  }, [screenId]);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    const settle = (state: DetailsState) => setResult({ key, attempt, reload: devReload, state });
    fetchElementDetails(key, controller.signal).then(
      (details) => {
        if (controller.signal.aborted) return;
        try {
          if (takeFault("detailsResponse")) throw new Error("Dev: error while handling the Details response");
          settle(details ? { status: "ready", details } : { status: "missing" });
        } catch (error) {
          failRegion(error);
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        reportOnce(error, { region: "details", screenId: screenIdRef.current, elementKey: key });
        settle({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [key, attempt, devReload, failRegion]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  let state: DetailsState | null = null;
  if (key !== null) {
    const current = result && result.key === key && result.attempt === attempt && result.reload === devReload;
    state = current ? result.state : LOADING;
  }
  return { state, retry };
}
