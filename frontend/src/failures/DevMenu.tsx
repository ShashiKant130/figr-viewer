import { useRef } from "react";
import { breakPreviewConnection, peerStatusStore } from "../bridge/hostBridge";
import { selectionStore } from "../overlay/selectionStore";
import { armFault, armRenderFault, devReload } from "./devFaults";
import { guard } from "./regions";

function targetPreview(): string | null {
  return selectionStore.get().screenId ?? Object.keys(peerStatusStore.get())[0] ?? null;
}

const ACTIONS: { group: string; items: { label: string; run: () => void }[] }[] = [
  {
    group: "Requests",
    items: [
      {
        label: "GET /screens fails",
        run: () => {
          armFault("screens");
          devReload("screens");
        },
      },
      {
        label: "GET /elements fails (selected element)",
        run: () => {
          armFault("details");
          devReload("details");
        },
      },
      {
        label: "Active preview can't connect (10 s)",
        run: () => {
          const screenId = targetPreview();
          if (screenId) breakPreviewConnection(screenId);
        },
      },
      { label: "Next row expand gets no answer (3 s)", run: () => armFault("children") },
    ],
  },
  {
    group: "Errors while rendering",
    items: [
      { label: "Board", run: () => armRenderFault("board") },
      { label: "Layers panel", run: () => armRenderFault("layers") },
      { label: "Inspector", run: () => armRenderFault("inspector") },
    ],
  },
  {
    group: "Errors elsewhere",
    items: [
      { label: "Next layers row click throws", run: () => armFault("layersClick") },
      { label: "Next preview message throws", run: () => armFault("message") },
      {
        label: "Details response handler throws",
        run: () => {
          armFault("detailsResponse");
          devReload("details");
        },
      },
      {
        label: "Inspector timer throws",
        run: () => {
          const context = () => ({ region: "inspector" as const, screenId: selectionStore.get().screenId });
          window.setTimeout(
            guard("inspector", context, () => {
              throw new Error("Dev: error in a timer");
            }),
            0,
          );
        },
      },
    ],
  },
];

/** Dev only: triggers each R6 failure on demand. Page errors come from the pages themselves. */
export function DevMenu() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <details className="dev-menu" ref={detailsRef}>
      <summary>Failures</summary>
      <div className="dev-menu-popover">
        {ACTIONS.map(({ group, items }) => (
          <div key={group} className="dev-menu-group">
            <div className="dev-menu-heading">{group}</div>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  detailsRef.current!.open = false;
                  item.run();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
        <div className="dev-menu-note">
          Page errors: click “Watch demo” on Landing in Interact mode, or wait 4 s after Docs loads.
        </div>
      </div>
    </details>
  );
}
