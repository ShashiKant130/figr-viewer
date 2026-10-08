import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { clearSelection } from "../bridge/hostBridge";
import { RenderFault } from "../failures/devFaults";
import { useGuard, useRegionFail } from "../failures/Region";
import { useStore } from "../lib/store";
import { wheelDeltaToPixels } from "../lib/dom";
import { modeStore } from "../modes";
import { Overlay } from "../overlay/Overlay";
import {
  cameraStore,
  fitToContent,
  panBy,
  setContentBounds,
  setViewportElement,
  zoomAtClient,
} from "./camera";
import { gridBounds, slotFor } from "./layout";
import { Preview } from "./Preview";
import { useScreens } from "./useScreens";

const DOT_SPACING = 24;
/** Screen px a press may move and still count as a click on empty board space. */
const CLICK_SLOP = 4;

export function Board() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const camera = useStore(cameraStore);
  const screens = useScreens();
  const [panning, setPanning] = useState(false);
  const fittedRef = useRef(false);
  const guard = useGuard();
  const fail = useRegionFail();

  useLayoutEffect(() => {
    setViewportElement(viewportRef.current);
    return () => setViewportElement(null);
  }, []);

  const screenList = screens.status === "ready" ? screens.screens : null;
  const slots = useMemo(() => screenList?.map((_, i) => slotFor(i)) ?? [], [screenList]);
  const slotsById = useMemo(
    () => new Map(screenList?.map((screen, i) => [screen.id, slots[i]] as const)),
    [screenList, slots],
  );

  useLayoutEffect(() => {
    if (!screenList) return;
    setContentBounds(gridBounds(screenList.length));
    if (!fittedRef.current) {
      fittedRef.current = true;
      fitToContent();
    }
  }, [screenList]);

  // Wheel over the board (never over a preview: those events go to the iframe and come back
  // from the agent as "zoom" messages). Native listener because React's is passive.
  useEffect(() => {
    const el = viewportRef.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      try {
        const page = el.clientHeight;
        if (event.ctrlKey || event.metaKey) {
          zoomAtClient(
            event.clientX,
            event.clientY,
            wheelDeltaToPixels(event.deltaY, event.deltaMode, page),
          );
          return;
        }
        let dx = wheelDeltaToPixels(event.deltaX, event.deltaMode, el.clientWidth);
        let dy = wheelDeltaToPixels(event.deltaY, event.deltaMode, page);
        if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
        panBy(-dx, -dy);
      } catch (error) {
        fail(error);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fail]);

  const drag = useRef<{
    pointerId: number;
    button: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if ((event.target as HTMLElement).closest("button, a, input, [data-no-pan]")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
    };
    setPanning(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    panBy(event.clientX - d.x, event.clientY - d.y);
    d.x = event.clientX;
    d.y = event.clientY;
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    const wasClick =
      event.type === "pointerup" &&
      d.button === 0 &&
      Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < CLICK_SLOP;
    if (wasClick && modeStore.get() === "select") clearSelection();
  };

  const dot = DOT_SPACING * camera.zoom;
  const viewportStyle: CSSProperties = {
    backgroundSize: `${dot}px ${dot}px`,
    backgroundPosition: `${camera.x}px ${camera.y}px`,
  };
  const worldStyle = {
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
    "--zoom": camera.zoom,
  } as CSSProperties;

  return (
    <div
      ref={viewportRef}
      className={`board${panning ? " is-panning" : ""}`}
      style={viewportStyle}
      onPointerDown={guard(onPointerDown)}
      onPointerMove={guard(onPointerMove)}
      onPointerUp={guard(endDrag)}
      onPointerCancel={guard(endDrag)}
      onLostPointerCapture={guard(endDrag)}
    >
      <RenderFault region="board" />
      <div className="world" style={worldStyle}>
        {screenList?.map((screen, i) => (
          <Preview key={screen.id} screen={screen} slot={slots[i]} />
        ))}
      </div>

      <Overlay slots={slotsById} />

      {screens.status === "loading" && <div className="board-message">Loading screens…</div>}
      {screens.status === "error" && (
        <div className="board-message board-message--error" role="alert" data-no-pan>
          <strong>Couldn't load screens</strong>
          <span>{screens.message}</span>
          <button type="button" onClick={screens.retry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
