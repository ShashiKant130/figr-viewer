import { useCallback, useEffect, useRef, useState } from "react";
import { fetchElementDetails, type ElementDetails } from "../api";
import { report } from "../../report.js";

export type DetailsState =
  | { status: "loading" }
  /** The API has no details for this key (404). Not an error. */
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; details: ElementDetails };

type Result = { key: string; attempt: number; state: DetailsState };

const LOADING: DetailsState = { status: "loading" };

/**
 * Details for one `data-key`. Changing the key or unmounting aborts the request in flight, and a
 * result is only shown for the key and attempt it was fetched for, so a slow answer for an older
 * selection can never appear. Aborted requests are not failures: nothing is shown or reported.
 */
export function useElementDetails(key: string | null, screenId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const screenIdRef = useRef(screenId);
  useEffect(() => {
    screenIdRef.current = screenId;
  }, [screenId]);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    fetchElementDetails(key, controller.signal).then(
      (details) => {
        if (controller.signal.aborted) return;
        setResult({ key, attempt, state: details ? { status: "ready", details } : { status: "missing" } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        report(error, { region: "details", screenId: screenIdRef.current, elementKey: key });
        const message = error instanceof Error ? error.message : String(error);
        setResult({ key, attempt, state: { status: "error", message } });
      },
    );
    return () => controller.abort();
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  let state: DetailsState | null = null;
  if (key !== null) {
    state = result && result.key === key && result.attempt === attempt ? result.state : LOADING;
  }
  return { state, retry };
}
