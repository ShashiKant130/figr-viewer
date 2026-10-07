// Runs inside every preview page (one <script> tag per page, loaded in <head>).
// It is the host's only way into a cross-origin page: all traffic is postMessage.
//
// agent -> host  { source: "figr-agent", session, type, ...payload }
//   hello   { url }                         sent until the host answers with "init"
//   zoom    { x, y, deltaY, deltaMode }     Ctrl/Cmd + wheel over the page
//   key     { key, shiftKey }               a host shortcut pressed while the page had focus
//   hover   { epoch, target }               target: { name, rect } in page viewport px, or null
//
// host -> agent  { source: "figr-host", type, ...payload }
//   init        { mode, hoverEpoch }
//   mode        { mode }                    "select" | "interact"
//   clearHover  { epoch }                   the host dropped the hover (pan, zoom, mode change);
//                                           stay quiet until the pointer moves again
(() => {
  if (window.parent === window) return;
  const script = document.currentScript;
  if (!script) return;

  const HOST_ORIGIN = new URL(script.src).origin;
  const session =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let mode = "select";
  let connected = false;

  function send(type, payload) {
    window.parent.postMessage({ source: "figr-agent", session, type, ...payload }, HOST_ORIGIN);
  }

  // The host may not have registered this iframe yet when the page boots, so keep saying hello.
  let helloAttempts = 0;
  const helloTimer = setInterval(() => {
    if (connected || ++helloAttempts > 30) return clearInterval(helloTimer);
    send("hello", { url: location.href });
  }, 500);
  send("hello", { url: location.href });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== HOST_ORIGIN) return;
    const msg = event.data;
    if (!msg || msg.source !== "figr-host") return;
    switch (msg.type) {
      case "init":
        connected = true;
        clearInterval(helloTimer);
        hoverEpoch = typeof msg.hoverEpoch === "number" ? msg.hoverEpoch : 0;
        setMode(msg.mode);
        break;
      case "mode":
        setMode(msg.mode);
        break;
      case "clearHover":
        if (typeof msg.epoch === "number") hoverEpoch = msg.epoch;
        suppressHover();
        break;
    }
  });

  // ---- Modes -------------------------------------------------------------

  // A constructed sheet adds no nodes to the page's DOM.
  const selectSheet = new CSSStyleSheet();
  selectSheet.replaceSync(
    "*, *::before, *::after { cursor: default !important; user-select: none !important; }",
  );
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, selectSheet];

  function setMode(next) {
    if (next !== "select" && next !== "interact") return;
    mode = next;
    selectSheet.disabled = mode !== "select";
    if (mode === "select") {
      blurActiveElement();
      if (pointer) startHoverLoop();
    } else {
      stopHoverLoop();
      setHover(null);
    }
  }

  function blurActiveElement() {
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === "function") active.blur();
  }

  // Registered on window in the capture phase from <head>, so these run before any page handler.
  const BLOCKED_IN_SELECT = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "dragstart",
    "selectstart",
    "submit",
  ];
  for (const type of BLOCKED_IN_SELECT) {
    window.addEventListener(
      type,
      (event) => {
        if (mode !== "select") return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, passive: false },
    );
  }

  window.addEventListener(
    "focusin",
    (event) => {
      if (mode === "select" && event.target !== document.body) event.target.blur?.();
    },
    true,
  );
  // focus() while the frame is unfocused fires no focusin, so re-check when the frame gains focus.
  window.addEventListener("focus", () => {
    if (mode === "select") blurActiveElement();
  });

  // ---- Wheel: plain wheel scrolls the page natively; Ctrl/Cmd + wheel zooms the board ----

  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      suppressHover();
      send("zoom", {
        x: event.clientX,
        y: event.clientY,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
    },
    { capture: true, passive: false },
  );

  // ---- Keyboard: focus lands inside the iframe after a click, so forward host shortcuts ----

  const SELECT_SHORTCUTS = new Set(["v", "i", "escape", "enter", "tab"]);
  const INTERACT_SHORTCUTS = new Set(["v", "i"]);

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    const nonText = ["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color"];
    return !nonText.includes((el.type || "").toLowerCase());
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (mode === "select") {
        if (!SELECT_SHORTCUTS.has(key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      } else {
        if (!INTERACT_SHORTCUTS.has(key) || isEditable(event.target)) return;
      }
      send("key", { key: event.key, shiftKey: event.shiftKey });
    },
    true,
  );

  // ---- Hover (Select mode) -------------------------------------------------
  // The element under the pointer is re-measured every frame while the pointer is in the page,
  // so the outline follows page scroll, nested scroll areas, resizes and re-renders. Only
  // changes are sent.

  let pointer = null; // { x, y } in this page's viewport px, or null when outside
  let hover = null; // last target sent: { name, x, y, width, height }
  let hoverEpoch = 0;
  let suppressed = false;
  let rafId = 0;

  function nameOf(el) {
    const dataName = el.getAttribute("data-name");
    if (dataName) return dataName;
    const tag = el.tagName.toLowerCase();
    if (el.classList.length > 0) return `${tag}.${el.classList[0]}`;
    if (el.id) return `${tag}#${el.id}`;
    return tag;
  }

  function elementAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement || el === document.body) return null;
    return el;
  }

  function sameTarget(a, b) {
    return (
      a.name === b.name &&
      Math.abs(a.x - b.x) < 0.01 &&
      Math.abs(a.y - b.y) < 0.01 &&
      Math.abs(a.width - b.width) < 0.01 &&
      Math.abs(a.height - b.height) < 0.01
    );
  }

  function setHover(next) {
    if (next === null ? hover === null : hover !== null && sameTarget(hover, next)) return;
    hover = next;
    send("hover", {
      epoch: hoverEpoch,
      target: next && {
        name: next.name,
        rect: { x: next.x, y: next.y, width: next.width, height: next.height },
      },
    });
  }

  function measureHover() {
    const el = elementAt(pointer.x, pointer.y);
    if (el) {
      const r = el.getBoundingClientRect();
      setHover({ name: nameOf(el), x: r.x, y: r.y, width: r.width, height: r.height });
    } else {
      setHover(null);
    }
  }

  function hoverTick() {
    rafId = 0;
    if (mode !== "select" || !pointer || suppressed) return;
    measureHover();
    rafId = requestAnimationFrame(hoverTick);
  }

  function startHoverLoop() {
    if (!rafId && connected) rafId = requestAnimationFrame(hoverTick);
  }

  function stopHoverLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /** The host already cleared its copy, so forget ours without sending anything. */
  function suppressHover() {
    suppressed = true;
    hover = null;
    stopHoverLoop();
  }

  function pointerLeft() {
    pointer = null;
    stopHoverLoop();
    setHover(null);
  }

  window.addEventListener(
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      suppressed = false;
      if (mode !== "select" || !connected) return;
      measureHover();
      startHoverLoop();
    },
    true,
  );
  document.documentElement.addEventListener("mouseleave", pointerLeft);
  window.addEventListener(
    "pointerout",
    (event) => {
      if (!event.relatedTarget) pointerLeft();
    },
    true,
  );
})();
