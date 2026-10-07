import { cameraStore, fitToContent, zoomAtViewportCenter } from "./board/camera";
import { useStore } from "./lib/store";
import { modeStore, setMode, type Mode } from "./modes";

const MODES: { id: Mode; label: string; shortcut: string }[] = [
  { id: "select", label: "Select", shortcut: "V" },
  { id: "interact", label: "Interact", shortcut: "I" },
];

export function Toolbar() {
  const mode = useStore(modeStore);
  const zoom = useStore(cameraStore, (c) => c.zoom);

  return (
    <header className="toolbar">
      <div className="toolbar-brand">Figr Viewer</div>

      <div className="segmented" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={mode === m.id ? "is-active" : undefined}
            onClick={() => setMode(m.id)}
            title={`${m.label} (${m.shortcut})`}
          >
            {m.label}
            <kbd>{m.shortcut}</kbd>
          </button>
        ))}
      </div>

      <div className="toolbar-zoom">
        <button type="button" onClick={() => zoomAtViewportCenter(1 / 1.25)} aria-label="Zoom out">
          −
        </button>
        <span className="toolbar-zoom-value">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => zoomAtViewportCenter(1.25)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={fitToContent}>
          Fit
        </button>
      </div>
    </header>
  );
}
