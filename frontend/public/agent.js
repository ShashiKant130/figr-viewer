// Runs inside every preview page (one <script> tag per page, loaded in <head>).
// It is the host's only way into a cross-origin page: all traffic is postMessage.
//
// agent -> host  { source: "figr-agent", session, type, ...payload }
//   hello   { url }                         sent until the host answers with "init"
//   zoom    { x, y, deltaY, deltaMode }     Ctrl/Cmd + wheel over the page
//   key     { key, shiftKey }               a host shortcut pressed while the page had focus
//   hover   { epoch, target }               target: { id, path, name, rect } or null; path is
//                                           the ids from the top-level element down to id
//   pick    { seq, shiftKey, target }       a click in Select mode (or a "pickId"); target:
//                                           { id, name, rect } or null for the page background
//   navigated { seq, from, target }         answer to "navigate"; target null means no move
//   selectionRects   { rects }              { [id]: rect } for selected elements that moved
//   selectionRemoved { ids }                selected elements that no longer exist
//   selectionProps   { props }              { [id]: live inspector values } for selected elements
//                                           whose values changed (sent before the pick that
//                                           selects them, so the host never waits on a frame)
//   childrenResult { req, id, nodes }       nodes: [{ id, name, hasChildren }] or null
//   revealResult   { req, id, path, lists } lists: { [parentId]: nodes } for every level of path
//   searchResult   { req, nodes, matches, truncated }
//                                           nodes: [{ id, name, hasChildren, parent }] in
//                                           document order, matches plus their ancestors
//   treeUpdate     { removed, changed }     changed: [{ id, hasChildren, children? }];
//                                           children only for parents the host has loaded
//
// host -> agent  { source: "figr-host", type, ...payload }
//   init        { mode, hoverEpoch }
//   mode        { mode }                    "select" | "interact"
//   clearHover  { epoch }                   the host dropped the hover (pan, zoom, mode change);
//                                           stay quiet until the pointer moves again
//   selection   { ids, seq }                the host's selection in this page, as of agent seq
//   navigate    { from, direction }         "firstChild" | "parent" | "next" | "prev"
//   children    { req, id }                 id "root" means <body>
//   reveal      { req, id }
//   search      { req, query }
//   hoverNode   { id }                      a layers row is hovered (null: no longer)
//   pickId      { id, shiftKey }            a layers row was clicked
//
// Element ids are only meaningful within one session (one page load). "root" is <body>.
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
      case "children":
        if (typeof msg.req === "number" && typeof msg.id === "string") answerChildren(msg.req, msg.id);
        break;
      case "reveal":
        if (typeof msg.req === "number" && typeof msg.id === "string") answerReveal(msg.req, msg.id);
        break;
      case "search":
        if (typeof msg.req === "number" && typeof msg.query === "string") {
          answerSearch(msg.req, msg.query);
        }
        break;
      case "hoverNode":
        hoverNode(typeof msg.id === "string" ? msg.id : null);
        break;
      case "pickId":
        if (typeof msg.id === "string") pickById(msg.id, msg.shiftKey === true);
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
      if (pointer || pinnedId) startHoverLoop();
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

  // ---- Element registry ----------------------------------------------------
  // Every element the host hears about (layers rows, hover, selection) gets one opaque id.
  //
  // When the page replaces a node (e.g. an innerHTML rebuild), its id moves to the successor
  // found with a recipe recorded at registration: the nearest element with a unique data-key or
  // id, then a path of steps from it that were each unique among their siblings. Anything that
  // can't be found unambiguously loses its id, so ids never move to a different element;
  // unkeyed rows in a rebuilt list get new ids this way.

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

  const nodes = new Map(); // id -> { el, desc }
  const idOf = new WeakMap(); // element -> id
  const descCache = new WeakMap(); // element -> recipe (or null)
  const loaded = new Set(); // ids whose children the host has, plus "root"
  let nextId = 0;

  function nameOf(el) {
    const dataName = el.getAttribute("data-name");
    if (dataName) return dataName;
    const tag = el.tagName.toLowerCase();
    if (el.classList.length > 0) return `${tag}.${el.classList[0]}`;
    if (el.id) return `${tag}#${el.id}`;
    return tag;
  }

  function isLayer(el) {
    return el.nodeType === 1 && !NON_LAYER_TAGS.has(el.tagName);
  }

  function layerChildren(el) {
    return Array.from(el.children).filter(isLayer);
  }

  function hasLayerChildren(el) {
    for (const child of el.children) if (isLayer(child)) return true;
    return false;
  }

  function isRoot(el) {
    return el === document.body || el === document.documentElement;
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
  function descOf(el) {
    if (descCache.has(el)) return descCache.get(el);
    let desc = null;
    if (isRoot(el)) {
      desc = { anchor: null, steps: [] };
    } else {
      const key = keyAttrOf(el);
      const parent = el.parentElement;
      if (key && findByAttr(key) === el) {
        desc = { anchor: key, steps: [] };
      } else if (parent) {
        const parentDesc = descOf(parent);
        const signature = signatureOf(el);
        if (parentDesc && uniqueChildWith(parent, signature) === el) {
          desc = { anchor: parentDesc.anchor, steps: [...parentDesc.steps, signature] };
        }
      }
    }
    descCache.set(el, desc);
    return desc;
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

  function idFor(el) {
    const known = idOf.get(el);
    if (known && nodes.get(known)?.el === el) return known;
    const id = `n${++nextId}`;
    nodes.set(id, { el, desc: descOf(el) });
    idOf.set(el, id);
    return id;
  }

  function elOf(id) {
    if (id === "root") return document.body;
    const node = nodes.get(id);
    return node && node.el.isConnected ? node.el : null;
  }

  function nodeInfo(el) {
    return { id: idFor(el), name: nameOf(el), hasChildren: hasLayerChildren(el) };
  }

  /** Ids from the top-level element (a child of <body>) down to el. */
  function pathOf(el) {
    const path = [];
    for (let node = el; node && !isRoot(node); node = node.parentElement) path.push(idFor(node));
    return path.reverse();
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

  function onMutations(records) {
    const removed = [];
    const rebound = [];
    for (const [id, node] of nodes) {
      if (node.el.isConnected) continue;
      const successor = refind(node.desc);
      const owner = successor && idOf.get(successor);
      const taken = owner && owner !== id && nodes.get(owner)?.el === successor;
      if (successor && !taken) {
        node.el = successor;
        idOf.set(successor, id);
        rebound.push(id);
      } else {
        nodes.delete(id);
        loaded.delete(id);
        removed.push(id);
      }
    }

    const changed = new Set(rebound);
    for (const record of records) {
      if (record.type !== "childList") continue;
      const target = record.target;
      if (target === document.body) changed.add("root");
      else if (nodes.get(idOf.get(target))?.el === target) changed.add(idOf.get(target));
    }

    if (connected && (removed.length > 0 || changed.size > 0)) {
      const updates = [];
      for (const id of changed) {
        const el = elOf(id);
        if (!el) continue;
        updates.push({
          id,
          hasChildren: hasLayerChildren(el),
          children: loaded.has(id) ? layerChildren(el).map(nodeInfo) : undefined,
        });
      }
      send("treeUpdate", { removed, changed: updates });
    }
    checkSelection();
  }

  // Attribute and text changes don't touch the tree, but they can change inspector values; frames
  // are throttled while the preview is off-screen, so mutations are the prompt signal.
  new MutationObserver(onMutations).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  // ---- Layers tree -----------------------------------------------------------

  function answerChildren(req, id) {
    const el = elOf(id);
    if (el) loaded.add(id);
    send("childrenResult", { req, id, nodes: el ? layerChildren(el).map(nodeInfo) : null });
  }

  /** Everything the host needs to show el: its path, and the children of every level above it. */
  function answerReveal(req, id) {
    const el = elOf(id);
    if (!el || el === document.body) {
      send("revealResult", { req, id, path: null, lists: null });
      return;
    }
    const path = pathOf(el);
    const lists = {};
    let parent = document.body;
    for (const key of ["root", ...path.slice(0, -1)]) {
      if (key !== "root") parent = elOf(key);
      if (!parent) break;
      lists[key] = layerChildren(parent).map(nodeInfo);
      loaded.add(key);
    }
    send("revealResult", { req, id, path, lists });
  }

  const SEARCH_LIMIT = 5000;

  /** Walks the whole page, including parts the host never loaded. Matching is case-insensitive. */
  function answerSearch(req, query) {
    const q = query.trim().toLowerCase();
    const all = [];
    const included = new Set();
    const matches = [];
    if (q) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (n) => (isLayer(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        all.push(el);
        if (!nameOf(el).toLowerCase().includes(q)) continue;
        matches.push(el);
        for (let n = el; n && !isRoot(n) && !included.has(n); n = n.parentElement) included.add(n);
      }
    }
    // Ancestors come before descendants in document order, so a cut never orphans a row.
    const kept = all.filter((el) => included.has(el));
    const truncated = kept.length > SEARCH_LIMIT;
    const out = kept.slice(0, SEARCH_LIMIT).map((el) => ({
      ...nodeInfo(el),
      parent: el.parentElement === document.body ? "root" : idFor(el.parentElement),
    }));
    const keptIds = new Set(out.map((n) => n.id));
    send("searchResult", {
      req,
      nodes: out,
      matches: matches.map(idFor).filter((id) => keptIds.has(id)),
      truncated,
    });
  }

  /** Scrolls only this page (nested scroll areas, then the window) until el is in view. */
  function scrollIntoPage(el) {
    for (let box = el.parentElement; box && !isRoot(box); box = box.parentElement) {
      const style = getComputedStyle(box);
      const scrollsY = /(auto|scroll|overlay)/.test(style.overflowY) && box.scrollHeight > box.clientHeight;
      const scrollsX = /(auto|scroll|overlay)/.test(style.overflowX) && box.scrollWidth > box.clientWidth;
      if (!scrollsY && !scrollsX) continue;
      const r = el.getBoundingClientRect();
      const c = box.getBoundingClientRect();
      const top = c.top + box.clientTop;
      const left = c.left + box.clientLeft;
      if (scrollsY) box.scrollTop += overflowBy(r.top, r.bottom, top, top + box.clientHeight);
      if (scrollsX) box.scrollLeft += overflowBy(r.left, r.right, left, left + box.clientWidth);
    }
    const r = el.getBoundingClientRect();
    const view = document.documentElement;
    window.scrollBy(
      overflowBy(r.left, r.right, 0, view.clientWidth),
      overflowBy(r.top, r.bottom, 0, view.clientHeight),
    );
  }

  /** How far to scroll so [start, end] is inside [min, max]; prefers showing the start. */
  function overflowBy(start, end, min, max) {
    if (start < min) return start - min;
    if (end > max) return Math.min(end - max, start - min);
    return 0;
  }

  function pickById(id, shiftKey) {
    if (mode !== "select") return;
    const el = elOf(id);
    if (!el || el === document.body) return;
    scrollIntoPage(el);
    pickSeq++;
    send("pick", { seq: pickSeq, shiftKey, target: track(el) });
  }

  // ---- Hover (Select mode) -------------------------------------------------
  // The element under the pointer (or the element of a hovered layers row) is re-measured every
  // frame, so the outline follows page scroll, nested scroll areas, resizes and re-renders. Only
  // changes are sent.

  let pointer = null; // { x, y } in this page's viewport px, or null when outside
  let pinnedId = null; // element of the hovered layers row; the real pointer wins over it
  let hover = null; // last target sent: { id, x, y, width, height }
  let hoverEpoch = 0;
  let suppressed = false;
  let rafId = 0;

  function elementAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement || el === document.body) return null;
    return el;
  }

  function setHover(next) {
    if (next === null) {
      if (hover === null) return;
      hover = null;
      send("hover", { epoch: hoverEpoch, target: null });
      return;
    }
    hover = next;
    send("hover", {
      epoch: hoverEpoch,
      target: {
        id: next.id,
        path: next.path,
        name: next.name,
        rect: { x: next.x, y: next.y, width: next.width, height: next.height },
      },
    });
  }

  function measureHover() {
    const el = pointer ? elementAt(pointer.x, pointer.y) : pinnedId ? elOf(pinnedId) : null;
    if (!el || el === document.body) return setHover(null);
    const r = el.getBoundingClientRect();
    const id = idFor(el);
    if (hover && hover.id === id && sameRect(hover, r)) return;
    setHover({ id, path: pathOf(el), name: nameOf(el), x: r.x, y: r.y, width: r.width, height: r.height });
  }

  function hoverTick() {
    rafId = 0;
    if (mode !== "select" || (!pointer && !pinnedId) || suppressed) return;
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
    pinnedId = null;
    hover = null;
    stopHoverLoop();
  }

  function pointerLeft() {
    pointer = null;
    stopHoverLoop();
    setHover(null);
  }

  function hoverNode(id) {
    pinnedId = id;
    if (pointer) return;
    if (!id) {
      stopHoverLoop();
      setHover(null);
      return;
    }
    if (mode !== "select" || !connected) return;
    suppressed = false;
    measureHover();
    startHoverLoop();
  }

  window.addEventListener(
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      pinnedId = null;
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
  // The host owns the selection; the agent measures the selected elements, reports their boxes
  // whenever they change and reports when they stop existing (their id was dropped above).

  const selected = new Map(); // id -> { touched, rect, live } (live: last sent props, as JSON)
  let pickSeq = 0;
  let selectionRaf = 0;

  function track(el) {
    const id = idFor(el);
    let entry = selected.get(id);
    if (!entry) {
      entry = { touched: 0, rect: null, live: null };
      selected.set(id, entry);
    }
    // Survives a host "selection" message that was sent before the host saw this pick.
    entry.touched = pickSeq;
    entry.rect = rectOf(el);
    const props = liveProps(el);
    entry.live = JSON.stringify(props);
    send("selectionProps", { props: { [id]: props } });
    startSelectionLoop();
    return { id, name: nameOf(el), rect: entry.rect };
  }

  function syncSelection(ids, seq) {
    const keep = new Set(ids);
    for (const [id, entry] of selected) {
      if (!keep.has(id) && entry.touched <= seq) selected.delete(id);
    }
    const missing = ids.filter((id) => !selected.has(id));
    if (missing.length > 0) send("selectionRemoved", { ids: missing });
    if (selected.size === 0) stopSelectionLoop();
  }

  function checkSelection() {
    if (selected.size === 0) return;
    const removed = [];
    const rects = {};
    const props = {};
    let moved = false;
    let changed = false;
    for (const [id, entry] of selected) {
      const el = elOf(id);
      if (!el) {
        selected.delete(id);
        removed.push(id);
        continue;
      }
      const rect = rectOf(el);
      if (!entry.rect || !sameRect(entry.rect, rect)) {
        entry.rect = rect;
        rects[id] = rect;
        moved = true;
      }
      const live = liveProps(el);
      const json = JSON.stringify(live);
      if (json !== entry.live) {
        entry.live = json;
        props[id] = live;
        changed = true;
      }
    }
    if (removed.length > 0) send("selectionRemoved", { ids: removed });
    if (moved) send("selectionRects", { rects });
    if (changed) send("selectionProps", { props });
  }

  // ---- Inspector (live values) -----------------------------------------------

  const TEXT_LIMIT = 120;

  function liveProps(el) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      elementId: el.id || "",
      classes: Array.from(el.classList),
      width: Math.round(r.width),
      height: Math.round(r.height),
      // Document coordinates: where the element sits in the page, whatever the page's scroll.
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      text: textOf(el),
      color: formatColor(parseColor(style.color)),
      background: seenBackground(el),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      key: el.getAttribute("data-key") || null,
    };
  }

  // Stops once enough text is collected, so a huge container costs no more than a small one.
  function textOf(el) {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && NON_LAYER_TAGS.has(parent.tagName)) continue;
      text = (text + node.data).replace(/\s+/g, " ");
      if (text.trimStart().length > TEXT_LIMIT) break;
    }
    return text.trim().slice(0, TEXT_LIMIT);
  }

  // The colour actually seen behind the element: its own background blended over its ancestors'
  // until one is opaque, then over the white canvas. Images, gradients and opacity are ignored.
  function seenBackground(el) {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let out = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    }
    return formatColor([out[0], out[1], out[2], 1]);
  }

  const RGB_PATTERN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/;
  const colorCache = new Map();
  let colorCtx = null;

  // Computed colours are usually rgb()/rgba(); anything else (oklch(), color(), ...) is resolved
  // by painting it on a detached 1×1 canvas.
  function parseColor(value) {
    const cached = colorCache.get(value);
    if (cached) return cached;
    let rgba;
    const m = RGB_PATTERN.exec(value);
    if (m) {
      const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
      rgba = [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
    } else {
      colorCtx ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = "rgba(0, 0, 0, 0)";
      colorCtx.fillStyle = value;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      rgba = [d[0], d[1], d[2], d[3] / 255];
    }
    if (colorCache.size > 500) colorCache.clear();
    colorCache.set(value, rgba);
    return rgba;
  }

  function formatColor([r, g, b, a]) {
    const hex = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ""}`;
  }

  // Every frame catches scroll, layout and size changes; frames are throttled while the preview
  // is off-screen, so DOM mutations are also checked directly to report removals promptly.
  function selectionTick() {
    selectionRaf = 0;
    if (selected.size === 0) return;
    checkSelection();
    selectionRaf = requestAnimationFrame(selectionTick);
  }

  function startSelectionLoop() {
    if (!selectionRaf && selected.size > 0) selectionRaf = requestAnimationFrame(selectionTick);
  }

  function stopSelectionLoop() {
    if (selectionRaf) cancelAnimationFrame(selectionRaf);
    selectionRaf = 0;
  }

  window.addEventListener("scroll", checkSelection, { capture: true, passive: true });

  function navigateFrom(id, direction) {
    const el = elOf(id);
    let target = null;
    if (el && el !== document.body) {
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
