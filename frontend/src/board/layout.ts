import {
  GRID_COLUMNS,
  GRID_GAP_X,
  GRID_GAP_Y,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
} from "../config";

export type Slot = { x: number; y: number };

/** World position of the i-th preview's frame (its name sits just above it). */
export function slotFor(index: number): Slot {
  const col = index % GRID_COLUMNS;
  const row = Math.floor(index / GRID_COLUMNS);
  return {
    x: col * (PREVIEW_WIDTH + GRID_GAP_X),
    y: row * (PREVIEW_HEIGHT + GRID_GAP_Y),
  };
}

export function gridBounds(count: number): { width: number; height: number } {
  if (count === 0) return { width: 0, height: 0 };
  const cols = Math.min(GRID_COLUMNS, count);
  const rows = Math.ceil(count / GRID_COLUMNS);
  return {
    width: cols * PREVIEW_WIDTH + (cols - 1) * GRID_GAP_X,
    height: rows * PREVIEW_HEIGHT + (rows - 1) * GRID_GAP_Y,
  };
}
