# Figr Viewer — Frontend Engineer take-home

A viewer for a design tool. A pannable, zoomable board shows 24 live previews, each a cross-origin `<iframe>`. You can hover and select elements inside any preview, browse the page's element tree in a layers panel, and read live values and API details in an inspector. Failures stay inside the part of the app where they happen.

The original brief is at the [bottom of this file](#assignment-brief).

## Running it

Requires Node 18+.

```
npm install     # also installs frontend/
npm start       # API :4000, pages :4001, app :5173
```

Open <http://localhost:5173>. The app must run on port 5173 (`strictPort`), because each preview page loads its script from `http://localhost:5173/agent.js`.

The **Failures** button in the toolbar is the dev-only failure menu.

## How it's built

There are two halves, and they only talk through `postMessage`:

- **The agent** (`frontend/public/agent.js`) is plain JavaScript, added to each page with the one allowed `<script>` tag in `<head>`. It is the only code that touches the page's DOM. It hit-tests the pointer, blocks clicks in Select mode, gives elements ids, measures boxes, walks the tree, reads computed styles, and catches page errors.
- **The host** (`frontend/src`) is a React + TypeScript app built with Vite. It owns the board, the selection, the layers panel, the inspector and failure handling. It never sees the page's DOM. It only knows element **ids**, names and boxes that the agent sends it.

```
frontend/
  public/agent.js           the in-page agent (protocol documented at the top)
  src/bridge/hostBridge.ts  the host's end of the protocol: connections, hover, selection, live values
  src/board/                camera (pan/zoom), grid layout, previews, screens request
  src/overlay/              hover/selection stores and the outline overlay
  src/layers/               layers controller (layers.ts), its store, and the panel
  src/inspector/            live values store, details request, inspector UI
  src/failures/             regions, error boundary, report-once, dev faults and menu
  src/lib/store.ts          a ~20-line external store (get / set / subscribe + useStore)
```

### Main design calls

- **Outlines are drawn by the host, not the page.** The agent sends element rectangles in the page's own coordinates. The host places them with `pan + zoom × (preview position + rect)` in one screen-space overlay. As a result, outlines stay 1px or 2px and labels stay the same size at every zoom, clipping to the preview is a plain `overflow: hidden` box, and nothing is injected into the page's DOM. (The agent's Select-mode cursor rule uses an adopted stylesheet, which adds no nodes.)
- **Native scrolling stays native.** The wheel over a preview scrolls the page itself, so nested scroll areas behave normally. The agent only intercepts **Ctrl/Cmd + wheel** and forwards it as `zoom`, which the host converts back to board coordinates.
- **The page is the source of truth for elements, and the host is the source of truth for selection.** The host stores opaque ids. The agent tracks what each id means across re-renders and reports when an id stops existing.
- **The layers tree loads lazily, keyed by request.** Every request carries a number. An answer whose number isn't the latest for that list is ignored, so late or duplicate answers can't add duplicate rows.
- **Each region contains its own failures.** A region is an error boundary plus a `guard()` wrapper for handlers, timers and async code. All of them go through one `failRegion` call, which shows the error and reports it once.

## Ambiguities and what I decided

**Elements and names**
- `<script>`, `<style>`, `<template>`, `<noscript>`, `<link>`, `<meta>`, `<title>`, `<base>` and `<head>` are not treated as elements. The brief says "any element except `<html>` and `<body>`", but these can't be seen or hovered. Landing has a `<script>` inside `<body>`, and it would show up as a confusing sibling. The same rule applies to the layers tree, keyboard navigation and inspector text.

**Modes and keyboard**
- **Shortcuts in Interact mode.** Only **V** and **I** reach the host, and never while focus is in an editable field. Typing "Ishan" into the sign-up form must not switch modes. Escape, Enter and Tab belong to the page in Interact mode.
- The host's own shortcuts are ignored while typing in the layers search box. Enter on a focused toolbar button presses the button.
- **Layers keyboard** applies while the tree itself has focus, which happens after clicking a row or tabbing to it.
- Clicking a row selects only in Select mode, because the selection is hidden in Interact mode.

**Board**
- A press on empty board space counts as a click (clearing the selection) only if the pointer moved less than 4px. Otherwise it's a pan.
- The **active preview** is the one last clicked in Select mode, including a click on its page background, which clears the selection but keeps that preview active.

**Layers panel**
- **Search** is a case-insensitive substring match on the row name, so "28.3" also matches "28.35".
- **Selecting while searching** scrolls to the result but doesn't expand the normal tree. Expanding would change the state that clearing the search has to restore exactly.
- **Very deep rows** scroll the panel horizontally, as in Figma. Names never squash to zero width, and revealing a deep row also scrolls sideways to its name.
- Selected rows use a tinted background. The brief only says "highlight".

**Failures**
- **Report regions** are `board`, `preview`, `layers` (the panel and its top-level list), `layers-row` (one row's children), `inspector` and `details`.
- **Page errors** are reported with region `preview` and also show the badge. The page keeps working, because an error inside the page isn't a failure of our preview. The badge clears when the page reloads or navigates.
- **Errors while handling a preview's message** fail whichever region that message feeds. Tree messages fail the layers panel. All other messages fail that preview.
- **Errors in the global keyboard handler** fail the board region.
- **A failed search** shows a Retry row inside the panel instead of failing the whole panel.
- **The 10-second connect timeout** also applies after a navigation. If the next page doesn't say hello within 10 seconds of the old one leaving, the preview fails.
- **Retry on a preview** remounts the iframe, which reloads the page. Retry on the board refetches `/screens`.

## State: what lives where, and who can change it

Each piece of shared state is a small external store (`lib/store.ts`) read through `useSyncExternalStore`. Components only **read** stores. Each store has **one writer module**, so "who changed this?" always has one answer.

| State | Where | Only written by |
|---|---|---|
| Camera `{ x, y, zoom }` | `board/camera.ts` | `camera.ts` (`panBy`, `zoomAt`, `fitToContent`), called by the board, toolbar and bridge |
| Mode (Select / Interact) | `modes.ts` | `setMode`, called by the toolbar and keyboard |
| Hover (one for the whole board) | `overlay/hoverStore.ts` | `bridge/hostBridge.ts` |
| Selection `{ screenId, ids, elements, lost }` | `overlay/selectionStore.ts` | `bridge/hostBridge.ts` |
| Live inspector values (screen → id → props) | `inspector/liveStore.ts` | `bridge/hostBridge.ts` |
| Connection status and page errors per preview | `bridge/hostBridge.ts` | `bridge/hostBridge.ts` |
| Layers tree per preview: nodes, child lists, expanded set, search, reveal | `layers/layersStore.ts` | `layers/layers.ts` |
| Layers scroll position per preview | `layers/layers.ts` (plain `Map`, not reactive) | `layers/layers.ts` |
| Region failures | `failures/regions.ts` | `failRegion` / `clearRegion` |
| Screens list, element details | local state in `useScreens` / `useElementDetails` | those hooks |
| Element ids → DOM elements | inside each page's agent | the agent |

## Host ↔ page protocol

The full message list, with payloads, is the comment at the top of `frontend/public/agent.js`.

- Agent → host messages are `{ source: "figr-agent", session, type, ... }`. They are posted only to the host's origin, which the agent reads from its own `<script src>`.
- Host → agent messages are `{ source: "figr-host", type, ... }`, posted only to the pages' origin.
- Both sides check the origin. The host also matches `event.source` to a registered iframe, and drops any message whose `session` isn't that iframe's current session.

### When one side is slow, gone or replaced

- **The page boots before the host is listening.** The agent sends `hello` every 500 ms (up to 15 s) until it receives `init`. Page errors raised before `init` are held and flushed on connect.
- **The page is slow or never connects.** The host starts a 10-second timer when the iframe mounts. If no `hello` arrives, that preview shows "Couldn't connect to this preview" and reports once. Retry reloads the iframe.
- **The page navigates or reloads.** `pagehide` sends `leaving`. The preview goes back to "connecting" and the 10-second timer restarts. The new page's agent says `hello` with a new session. The host then:
  - clears that preview's selection, hover, live values and page errors;
  - resets its layers tree;
  - sends `init` with the current mode, so a page loaded in Interact mode still respects Select mode later.

  Messages still arriving from the old session are dropped.
- **The page is slow answering a tree request.** After 3 seconds the row shows "Couldn't load" and reports once. A late answer has a stale `req` and is ignored. Collapsing and re-expanding reuses the request already in flight instead of sending a second one.
- **The page answers with garbage.** Every payload is validated. An invalid tree answer marks that list as failed. Invalid hover or selection data is ignored.
- **The preview is removed** (Retry, or the board refetching screens). Unregistering clears its timer and state. Later messages from it match no registered iframe and are dropped. A failure for a region that has unmounted is ignored.
- **The details request is slow or replaced.** Each request is cancelled with `AbortController` when the selection changes. Results are keyed by element key and attempt, so only the latest selection's details are shown. Cancelled requests are neither errors nor reports.
- **The host goes away.** The pages reload with it, so there is nothing to clean up on the page side.

## Failures (R6)

- **`<Region id>`** wraps:
  - the board;
  - each preview (`preview:<screenId>`);
  - the layers panel;
  - the inspector;
  - the Details section.

  A row's child loading is its own region in the tree state, with its own Retry.
- **Render errors** are caught by the region's error boundary.
- **Handlers, timers and message callbacks** are wrapped in `guard(region, …)`.
- **Async results** call the region's `fail` function.

All three paths end in `failRegion`, which:
- ignores regions that are no longer mounted (R6.6);
- ignores a region that's already showing an error;
- otherwise reports through `reportOnce` (a `WeakSet` of reported error objects) and stores the error for the fallback UI.

**Retry** clears the error and remounts the region. If it fails again, that's a new error object and a new report.

**Page errors** come from the agent's `error` and `unhandledrejection` listeners. Each one is reported once (region `preview`) and listed in the preview's badge tooltip.

**The dev menu** triggers each case on demand:
- `/screens` and `/elements` failures (through `?fail=1`);
- a preview that never connects;
- a row expand that's never answered;
- render errors in the board, layers panel and inspector;
- throws in a row click, a preview message handler, the details response handler and a timer.

Page errors come from the pages themselves. Docs throws about 4 s after load, and "Watch demo" on Landing throws in Interact mode.

## Where this breaks

1. **Look-alike replacement (the one case where selection can move to a different element).** Suppose a page removes an element and inserts a **different** element that has the same tag, classes, `data-key` and `data-name`, in the same uniquely identifiable place. The agent can't tell them apart, so the id, and with it the selection, moves to the new element. Detecting this would need content or position heuristics, which create their own wrong matches.
2. **Unkeyed rebuilt lists.** Rows rebuilt from `innerHTML` with no `data-key` or `id` are dropped from the selection, and their expanded state is lost, on every rebuild. The new rows appear under new ids. This is by design: dropping is better than guessing.
3. **Duplicate `id` / `data-key` values** in a page aren't used as anchors. If no unique path exists either, those elements can't survive a rebuild.
4. **Errors before the agent runs**, or in inline scripts earlier in `<head>`, aren't caught. Errors from cross-origin scripts inside a page show up as "Script error".
5. **Search over very large pages** is capped at 5,000 result nodes and runs in one pass in the page. A page with hundreds of thousands of elements would pause briefly on each keystroke after the 150 ms debounce.

## What I took from existing products

- **Figma:**
  - deep layer rows scroll horizontally instead of squashing their names;
  - the hover outline is thin, and the selection outline is thicker and a different colour;
  - name labels sit just outside the element's box.

---