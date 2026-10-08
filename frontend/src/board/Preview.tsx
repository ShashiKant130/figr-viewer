import { memo, useLayoutEffect, useRef } from "react";
import type { Screen } from "../api";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "../config";
import { pageErrorStore, peerStatusStore, registerPreview } from "../bridge/hostBridge";
import { Region, RegionError } from "../failures/Region";
import { previewRegion } from "../failures/regions";
import { useStore } from "../lib/store";
import type { Slot } from "./layout";

type Props = { screen: Screen; slot: Slot };

export const Preview = memo(function Preview({ screen, slot }: Props) {
  const status = useStore(peerStatusStore, (s) => s[screen.id] ?? "connecting");

  return (
    <div
      className="preview"
      style={{ left: slot.x, top: slot.y, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}
    >
      <div className="preview-name" title={screen.name}>
        <span className={`preview-status preview-status--${status}`} aria-label={status} />
        {screen.name}
      </div>
      <PageErrorBadge screenId={screen.id} />
      <Region
        id={previewRegion(screen.id)}
        context={() => ({ region: "preview", screenId: screen.id })}
        fallback={(failure, retry) => (
          <RegionError
            className="preview-error"
            failure={failure}
            retry={retry}
            fallbackTitle="This preview stopped working"
          />
        )}
      >
        <PreviewFrame screen={screen} />
      </Region>
    </div>
  );
});

function PreviewFrame({ screen }: { screen: Screen }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Layout effect: register before the page's agent can say hello.
  useLayoutEffect(() => registerPreview(screen.id, iframeRef.current!), [screen.id]);

  return (
    <iframe
      ref={iframeRef}
      className="preview-frame"
      src={screen.url}
      title={screen.name}
      width={PREVIEW_WIDTH}
      height={PREVIEW_HEIGHT}
    />
  );
}

function PageErrorBadge({ screenId }: { screenId: string }) {
  const errors = useStore(pageErrorStore, (s) => s[screenId]);
  if (!errors || errors.length === 0) return null;
  const label = errors.length === 1 ? "Page error" : `Page errors (${errors.length})`;
  return (
    <span className="preview-badge" data-no-pan tabIndex={0} aria-label={`${label}: ${errors.at(-1)}`}>
      {label}
      <span className="preview-badge-tooltip" role="tooltip">
        {errors.map((message, i) => (
          <span key={i}>{message}</span>
        ))}
      </span>
    </span>
  );
}
