import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "../config";
import { cameraStore, type Camera } from "../board/camera";
import type { Slot } from "../board/layout";
import { useStore } from "../lib/store";
import { modeStore } from "../modes";
import { hoverStore, type PageRect } from "./hoverStore";

type Props = { slots: ReadonlyMap<string, Slot> };

/**
 * Drawn in screen space on top of the scaled world, so outlines stay 1px and labels keep their
 * size at any zoom. Each preview gets a clip box matching its frame on screen.
 */
export function Overlay({ slots }: Props) {
  const camera = useStore(cameraStore);
  const mode = useStore(modeStore);
  const hover = useStore(hoverStore);

  if (mode !== "select" || !hover) return null;
  const slot = slots.get(hover.screenId);
  if (!slot) return null;

  return (
    <div className="overlay" aria-hidden>
      <PreviewClip slot={slot} camera={camera}>
        <ElementBox rect={hover.rect} name={hover.name} zoom={camera.zoom} variant="hover" />
      </PreviewClip>
    </div>
  );
}

function PreviewClip({
  slot,
  camera,
  children,
}: {
  slot: Slot;
  camera: Camera;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overlay-clip"
      style={{
        left: camera.x + slot.x * camera.zoom,
        top: camera.y + slot.y * camera.zoom,
        width: PREVIEW_WIDTH * camera.zoom,
        height: PREVIEW_HEIGHT * camera.zoom,
      }}
    >
      {children}
    </div>
  );
}

const LABEL_HEIGHT = 18;
const LABEL_GAP = 2;

function ElementBox({
  rect,
  name,
  zoom,
  variant,
}: {
  rect: PageRect;
  name: string;
  zoom: number;
  variant: "hover" | "selected";
}) {
  const left = rect.x * zoom;
  const top = rect.y * zoom;
  const width = rect.width * zoom;
  const height = rect.height * zoom;
  const clipHeight = PREVIEW_HEIGHT * zoom;

  const visible =
    left < PREVIEW_WIDTH * zoom && top < clipHeight && left + width > 0 && top + height > 0;
  if (!visible) return null;

  // Above the element when it fits inside the preview, else below, else pinned inside the top.
  const above = top - LABEL_HEIGHT - LABEL_GAP;
  const below = top + height + LABEL_GAP;
  const labelTop =
    above >= 0 ? above : below + LABEL_HEIGHT <= clipHeight ? below : Math.max(top, 0);

  return (
    <>
      <div className={`overlay-box overlay-box--${variant}`} style={{ left, top, width, height }} />
      <div
        className={`overlay-label overlay-label--${variant}`}
        style={{ left: Math.max(left, 0), top: labelTop, height: LABEL_HEIGHT }}
      >
        {name}
      </div>
    </>
  );
}
