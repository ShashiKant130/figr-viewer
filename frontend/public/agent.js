// Runs inside every preview page (one <script> tag per page, loaded in <head>).
// It is the host's only way into a cross-origin page: all traffic is postMessage.
//
// agent -> host  { source: "figr-agent", session, type, ...payload }
//   hello   { url }                         sent until the host answers with "init"
//   zoom    { x, y, deltaY, deltaMode }     Ctrl/Cmd + wheel over the page
//   key     { key, shiftKey }               a host shortcut pressed while the page had focus
//   hover   { epoch, target }               target: { name, rect } in page viewport px, or null
//   pick    { seq, shiftKey, target }       a click in Select mode; target: { id, name, rect } or
//                                           null for the page background
//   navigated { seq, from, target }         answer to "navigate"; target null means no move
//   selectionRects   { rects }              { [id]: rect } for selected elements that moved
//   selectionRemoved { ids }                selected elements that no longer exist
//
// host -> agent  { source: "figr-host", type, ...payload }
//   init        { mode, hoverEpoch }
//   mode        { mode }                    "select" | "interact"
//   clearHover  { epoch }                   the host dropped the hover (pan, zoom, mode change);
//                                           stay quiet until the pointer moves again
//   selection   { ids, seq }                the host's selection in this page, as of agent seq
//   navigate    { from, direction }         "firstChild" | "parent" | "next" | "prev"
//
// Element ids are only meaningful within one session (one page load).
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
      case "selection":
        if (Array.isArray(msg.ids) && typeof msg.seq === "number") {
          syncSelection(msg.ids.filter((id) => typeof id === "string"), msg.seq);
        }
        break;
      case "navigate":
        if (typeof msg.from === "string") navigateFrom(msg.from, msg.direction);
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

  // Pointer events still fire on disabled controls, unlike click. Registered before the blockers
  // below, which stop propagation to later listeners.
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (mode !== "select" || !connected || event.button !== 0 || !event.isPrimary) return;
      const el = elementAt(event.clientX, event.clientY);
      pickSeq++;
      send("pick", { seq: pickSeq, shiftKey: event.shiftKey, target: el && track(el) });
    },
    true,
  );

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

  // ---- Selection -----------------------------------------------------------
  // The host owns the selection; the agent keeps the selected elements behind opaque ids,
  // reports their boxes whenever they change and reports when they stop existing.
  //
  // When the page replaces a selected node (e.g. an innerHTML rebuild), the agent looks for
  // its successor using a description recorded at selection time: the nearest element with a
  // unique data-key or id, then a path of steps from it that were each unique among their
  // siblings. Anything that can't be found unambiguously is dropped, so the selection never
  // moves to a different element; unkeyed rows in a rebuilt list are dropped this way.

  const NON_LAYER_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "TEMPLATE",
    "NOSCRIPT",
    "LINK",
    "META",
    "TITLE",
    "BASE",
    "HEAD",
  ]);

  const tracked = new Map(); // id -> { el, desc, touched, rect }
  const idOf = new WeakMap(); // element -> id
  let nextId = 0;
  let pickSeq = 0;
  let selectionRaf = 0;

  function isLayer(el) {
    return el.nodeType === 1 && !NON_LAYER_TAGS.has(el.tagName);
  }

  function layerChildren(el) {
    return Array.from(el.children).filter(isLayer);
  }

  function isRoot(el) {
    return el === document.body || el === document.documentElement;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function sameRect(a, b) {
    return (
      Math.abs(a.x - b.x) < 0.01 &&
      Math.abs(a.y - b.y) < 0.01 &&
      Math.abs(a.width - b.width) < 0.01 &&
      Math.abs(a.height - b.height) < 0.01
    );
  }

  function keyAttrOf(el) {
    const key = el.getAttribute("data-key");
    if (key) return { attr: "data-key", value: key };
    if (el.id) return { attr: "id", value: el.id };
    return null;
  }

  function findByAttr({ attr, value }) {
    const matches = document.querySelectorAll(`[${attr}="${CSS.escape(value)}"]`);
    return matches.length === 1 ? matches[0] : null;
  }

  function signatureOf(el) {
    return [
      el.tagName,
      el.getAttribute("data-key") || "",
      el.getAttribute("data-name") || "",
      Array.from(el.classList).sort().join(" "),
    ].join("|");
  }

  function uniqueChildWith(parent, signature) {
    let found = null;
    for (const child of parent.children) {
      if (signatureOf(child) !== signature) continue;
      if (found) return null;
      found = child;
    }
    return found;
  }

  /** How to find this element again after the page rebuilds it, or null if that's unsafe. */
  function describe(el) {
    const steps = [];
    let node = el;
    while (!isRoot(node)) {
      const key = keyAttrOf(node);
      if (key && findByAttr(key) === node) return { anchor: key, steps: steps.reverse() };
      const parent = node.parentElement;
      if (!parent) return null;
      const signature = signatureOf(node);
      if (uniqueChildWith(parent, signature) !== node) return null;
      steps.push(signature);
      node = parent;
    }
    return { anchor: null, steps: steps.reverse() };
  }

  function refind(desc) {
    if (!desc) return null;
    let node = desc.anchor ? findByAttr(desc.anchor) : document.body;
    for (const signature of desc.steps) {
      if (!node) return null;
      node = uniqueChildWith(node, signature);
    }
    return node && !isRoot(node) ? node : null;
  }

  function track(el) {
    let id = idOf.get(el);
    let entry = id && tracked.get(id);
    if (!entry || entry.el !== el) {
      id = `e${++nextId}`;
      entry = { el, desc: describe(el), touched: 0, rect: null };
      tracked.set(id, entry);
      idOf.set(el, id);
    }
    // Survives a host "selection" message that was sent before the host saw this pick.
    entry.touched = pickSeq;
    entry.rect = rectOf(el);
    startSelectionLoop();
    return { id, name: nameOf(el), rect: entry.rect };
  }

  function untrack(id) {
    const entry = tracked.get(id);
    if (!entry) return;
    tracked.delete(id);
    if (idOf.get(entry.el) === id) idOf.delete(entry.el);
  }

  function syncSelection(ids, seq) {
    const keep = new Set(ids);
    for (const [id, entry] of tracked) {
      if (!keep.has(id) && entry.touched <= seq) untrack(id);
    }
    const missing = ids.filter((id) => !tracked.has(id));
    if (missing.length > 0) send("selectionRemoved", { ids: missing });
    if (tracked.size === 0) stopSelectionLoop();
  }

  function checkSelection() {
    if (tracked.size === 0) return;
    const removed = [];
    const rects = {};
    let moved = false;
    for (const [id, entry] of tracked) {
      if (!entry.el.isConnected) {
        const successor = refind(entry.desc);
        const owner = successor && idOf.get(successor);
        if (!successor || (owner && owner !== id && tracked.has(owner))) {
          untrack(id);
          removed.push(id);
          continue;
        }
        entry.el = successor;
        idOf.set(successor, id);
      }
      const rect = rectOf(entry.el);
      if (!entry.rect || !sameRect(entry.rect, rect)) {
        entry.rect = rect;
        rects[id] = rect;
        moved = true;
      }
    }
    if (removed.length > 0) send("selectionRemoved", { ids: removed });
    if (moved) send("selectionRects", { rects });
  }

  // Every frame catches scroll, layout and size changes; frames are throttled while the preview
  // is off-screen, so DOM mutations are also checked directly to report removals promptly.
  function selectionTick() {
    selectionRaf = 0;
    if (tracked.size === 0) return;
    checkSelection();
    selectionRaf = requestAnimationFrame(selectionTick);
  }

  function startSelectionLoop() {
    if (!selectionRaf && tracked.size > 0) selectionRaf = requestAnimationFrame(selectionTick);
  }

  function stopSelectionLoop() {
    if (selectionRaf) cancelAnimationFrame(selectionRaf);
    selectionRaf = 0;
  }

  new MutationObserver(checkSelection).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("scroll", checkSelection, { capture: true, passive: true });

  function navigateFrom(id, direction) {
    checkSelection();
    const entry = tracked.get(id);
    let target = null;
    if (entry) {
      const el = entry.el;
      const parent = el.parentElement;
      if (direction === "firstChild") {
        target = layerChildren(el)[0] || null;
      } else if (direction === "parent") {
        target = parent && !isRoot(parent) ? parent : null;
      } else if ((direction === "next" || direction === "prev") && parent) {
        const siblings = layerChildren(parent);
        const index = siblings.indexOf(el);
        if (index >= 0 && siblings.length > 1) {
          const step = direction === "next" ? 1 : -1;
          target = siblings[(index + step + siblings.length) % siblings.length];
        }
      }
    }
    pickSeq++;
    send("navigated", { seq: pickSeq, from: id, target: target && track(target) });
  }
})();
