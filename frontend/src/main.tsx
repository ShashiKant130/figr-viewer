import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installHostBridge } from "./bridge/hostBridge";
import { handleShortcut, installHostShortcuts } from "./keyboard";
import "./styles.css";

installHostBridge({ onKey: handleShortcut });
installHostShortcuts();

// Ctrl/Cmd + wheel must never zoom the browser tab, even over the toolbar or panels.
window.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  },
  { passive: false },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
