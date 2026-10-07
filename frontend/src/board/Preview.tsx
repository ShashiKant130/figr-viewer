import { memo, useLayoutEffect, useRef } from "react";
import type { Screen } from "../api";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "../config";
import { peerStatusStore, registerPreview } from "../bridge/hostBridge";
import { useStore } from "../lib/store";
import type { Slot } from "./layout";

type Props = { screen: Screen; slot: Slot };

export const Preview = memo(function Preview({ screen, slot }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const status = useStore(peerStatusStore, (s) => s[screen.id] ?? "connecting");

  // Layout effect: register before the page's agent can say hello.
  useLayoutEffect(() => registerPreview(screen.id, iframeRef.current!), [screen.id]);

  return (
    <div
      className="preview"
      style={{ left: slot.x, top: slot.y, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}
    >
      <div className="preview-name" title={screen.name}>
        <span className={`preview-status preview-status--${status}`} aria-label={status} />
        {screen.name}
      </div>
      <iframe
        ref={iframeRef}
        className="preview-frame"
        src={screen.url}
        title={screen.name}
        width={PREVIEW_WIDTH}
        height={PREVIEW_HEIGHT}
      />
    </div>
  );
});
