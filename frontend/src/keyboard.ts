import { clearSelection, navigateSelection } from "./bridge/hostBridge";
import { isEditableTarget } from "./lib/dom";
import { modeStore, setMode } from "./modes";

export type ShortcutKey = {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

/**
 * One entry point for shortcuts, whether the key was pressed in the host or forwarded by an
 * agent because focus was inside a preview. Returns true when the key was consumed.
 */
export function handleShortcut(k: ShortcutKey): boolean {
  if (k.ctrlKey || k.metaKey || k.altKey) return false;
  const key = k.key.toLowerCase();
  switch (key) {
    case "v":
      setMode("select");
      return true;
    case "i":
      setMode("interact");
      return true;
  }
  // The selection is hidden in Interact mode, so it can't be cleared or moved there.
  if (modeStore.get() !== "select") return false;
  switch (key) {
    case "escape":
      return clearSelection();
    case "enter":
      return navigateSelection(k.shiftKey ? "parent" : "firstChild");
    case "tab":
      return navigateSelection(k.shiftKey ? "prev" : "next");
    default:
      return false;
  }
}

let installed = false;
export function installHostShortcuts() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) return;
    // Enter on a focused toolbar button should press it.
    if (event.key === "Enter" && (event.target as Element | null)?.closest?.("button, a")) return;
    if (handleShortcut(event)) event.preventDefault();
  });
}
