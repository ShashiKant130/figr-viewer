import { useCallback, useEffect, useState } from "react";
import { fetchScreens, type Screen } from "../api";
import { report } from "../../report.js";

export type ScreensState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; screens: Screen[] };

export function useScreens(): ScreensState & { retry: () => void } {
  const [state, setState] = useState<ScreensState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchScreens(controller.signal).then(
      (screens) => {
        if (!controller.signal.aborted) setState({ status: "ready", screens });
      },
      (error: unknown) => {
        // Aborted means the board moved on (unmount or retry); that is not a failure.
        if (controller.signal.aborted) return;
        report(error, { region: "board", screenId: null });
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
