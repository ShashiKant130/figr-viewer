import { isEditableTarget } from "./lib/dom";
import { setMode } from "./modes";

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
  switch (k.key.toLowerCase()) {
    case "v":
      setMode("select");
      return true;
    case "i":
      setMode("interact");
      return true;
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
    if (handleShortcut(event)) event.preventDefault();
  });
}
