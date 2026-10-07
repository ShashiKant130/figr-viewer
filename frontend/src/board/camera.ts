import { MAX_ZOOM, MIN_ZOOM } from "../config";
import { createStore } from "../lib/store";

/** Screen position of a world point p is `pan + p * zoom`, relative to the board viewport. */
export type Camera = { x: number; y: number; zoom: number };

export const cameraStore = createStore<Camera>({ x: 0, y: 0, zoom: 1 });

/** Fires when a pan or zoom gesture starts or steps; hover clears on it (R2). */
const motionListeners = new Set<() => void>();
export function onCameraMotion(listener: () => void): () => void {
  motionListeners.add(listener);
  return () => motionListeners.delete(listener);
}
function notifyMotion() {
  motionListeners.forEach((listener) => listener());
}

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

let viewport: HTMLElement | null = null;
export function setViewportElement(el: HTMLElement | null) {
  viewport = el;
}

export function panBy(dx: number, dy: number) {
  if (dx === 0 && dy === 0) return;
  notifyMotion();
  cameraStore.set((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
}

/** Zooms by `factor`, keeping the world point under (vx, vy) fixed on screen. */
export function zoomAt(vx: number, vy: number, factor: number) {
  const camera = cameraStore.get();
  const zoom = clampZoom(camera.zoom * factor);
  if (zoom === camera.zoom) return;
  notifyMotion();
  const ratio = zoom / camera.zoom;
  cameraStore.set({
    zoom,
    x: vx - (vx - camera.x) * ratio,
    y: vy - (vy - camera.y) * ratio,
  });
}

const ZOOM_SPEED = 0.0025;
const MAX_STEP_PX = 120;

/** Wheel-driven zoom at a point given in window client coordinates. */
export function zoomAtClient(clientX: number, clientY: number, deltaPx: number) {
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const step = Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, deltaPx));
  zoomAt(clientX - rect.left, clientY - rect.top, Math.exp(-step * ZOOM_SPEED));
}

export function zoomAtViewportCenter(factor: number) {
  if (!viewport) return;
  zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
}

type Bounds = { width: number; height: number };
let contentBounds: Bounds | null = null;
export function setContentBounds(bounds: Bounds | null) {
  contentBounds = bounds;
}

const FIT_PADDING = 48;

/** Fits the grid's width (it is far taller than wide), top-aligned, never above 100%. */
export function fitToContent() {
  if (!viewport || !contentBounds) return;
  const { clientWidth, clientHeight } = viewport;
  const zoom = clampZoom(
    Math.min(1, (clientWidth - FIT_PADDING * 2) / contentBounds.width),
  );
  const scaledWidth = contentBounds.width * zoom;
  const x = scaledWidth < clientWidth ? (clientWidth - scaledWidth) / 2 : FIT_PADDING;
  const scaledHeight = contentBounds.height * zoom;
  const y = scaledHeight < clientHeight ? (clientHeight - scaledHeight) / 2 : FIT_PADDING;
  notifyMotion();
  cameraStore.set({ x, y, zoom });
}
