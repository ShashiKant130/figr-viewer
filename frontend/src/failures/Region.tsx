import {
  Component,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "../lib/store";
import { disarmRenderFault } from "./devFaults";
import {
  clearRegion,
  failRegion,
  mountRegion,
  regionErrorStore,
  type RegionFailure,
  type ReportContext,
} from "./regions";

type Props = {
  /** Region key in regionErrorStore. */
  id: string;
  /** Read when a failure is reported, so it reflects the state at that moment. */
  context: () => ReportContext;
  fallback: (failure: RegionFailure, retry: () => void) => ReactNode;
  children: ReactNode;
};

const RegionFailContext = createContext<((error: unknown) => void) | null>(null);

/**
 * A failure boundary. Render errors are caught by the boundary below; errors from handlers,
 * timers and async callbacks reach the same state through `useGuard` / `useRegionFail` or
 * `guard()`. Either way the region shows `fallback` and the failure is reported once.
 */
export function Region({ id, context, fallback, children }: Props) {
  const failure = useStore(regionErrorStore, (s) => s[id]);
  const [generation, setGeneration] = useState(0);
  const contextRef = useRef(context);
  useLayoutEffect(() => {
    contextRef.current = context;
  });
  useLayoutEffect(() => mountRegion(id), [id]);

  const fail = useCallback((error: unknown) => failRegion(id, error, contextRef.current()), [id]);
  const failFromRender = useCallback(
    (error: unknown) => failRegion(id, error, contextRef.current(), { force: true }),
    [id],
  );
  const retry = useCallback(() => {
    disarmRenderFault(id);
    clearRegion(id);
    setGeneration((g) => g + 1);
  }, [id]);

  if (failure) return <>{fallback(failure, retry)}</>;
  return (
    <RegionFailContext.Provider value={fail}>
      <RenderBoundary key={generation} onError={failFromRender}>
        {children}
      </RenderBoundary>
    </RegionFailContext.Provider>
  );
}

class RenderBoundary extends Component<
  { onError: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Fails the nearest region; for async callbacks inside it. */
export function useRegionFail(): (error: unknown) => void {
  const fail = useContext(RegionFailContext);
  return fail ?? rethrow;
}

/** Wraps event handlers so a throw fails the nearest region instead of escaping. */
export function useGuard() {
  const fail = useRegionFail();
  return useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        try {
          fn(...args);
        } catch (error) {
          fail(error);
        }
      },
    [fail],
  );
}

function rethrow(error: unknown): never {
  throw error;
}

export function RegionError({
  failure,
  retry,
  className,
  fallbackTitle,
}: {
  failure: RegionFailure;
  retry: () => void;
  className?: string;
  fallbackTitle: string;
}) {
  return (
    <div className={`region-error${className ? ` ${className}` : ""}`} role="alert" data-no-pan>
      <strong>{failure.title ?? fallbackTitle}</strong>
      <span className="region-error-message">{failure.message}</span>
      <button type="button" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
