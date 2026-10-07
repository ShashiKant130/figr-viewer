import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installHostBridge } from "./bridge/hostBridge";
import { installHostShortcuts } from "./keyboard";
import "./styles.css";

installHostBridge();
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
