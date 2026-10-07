// Runs inside every preview page (one <script> tag per page, loaded in <head>).
// It is the host's only way into a cross-origin page: all traffic is postMessage.
//
// agent -> host  { source: "figr-agent", session, type, ...payload }
//   hello   { url }                         sent until the host answers with "init"
//   zoom    { x, y, deltaY, deltaMode }     Ctrl/Cmd + wheel over the page
//   key     { key, shiftKey }               a host shortcut pressed while the page had focus
//
// host -> agent  { source: "figr-host", type, ...payload }
//   init    { mode }
//   mode    { mode }                        "select" | "interact"
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
        setMode(msg.mode);
        break;
      case "mode":
        setMode(msg.mode);
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
    if (mode === "select") blurActiveElement();
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
})();
