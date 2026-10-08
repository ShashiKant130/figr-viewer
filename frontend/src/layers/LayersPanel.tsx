import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RenderFault, takeFault } from "../failures/devFaults";
import { Region, RegionError, useGuard } from "../failures/Region";
import { useStore } from "../lib/store";
import { hoverStore } from "../overlay/hoverStore";
import { selectionStore } from "../overlay/selectionStore";
import {
  ensureLoaded,
  hoverRow,
  pickRow,
  retry,
  retrySearch,
  savedScrollTop,
  saveScrollTop,
  setExpanded,
  setSearch,
  toggleExpanded,
} from "./layers";
import { EMPTY_TREE, ROOT, layersStore, visibleRows, type Row } from "./layersStore";

const ROW_HEIGHT = 24;
const INDENT = 12;
const NAME_MIN_WIDTH = 120;
const OVERSCAN = 10;

export function LayersPanel() {
  const screenId = useStore(selectionStore, (s) => s.screenId);
  return (
    <aside className="panel panel--layers">
      <div className="panel-header">Layers</div>
      <Region
        id="layers"
        context={() => ({ region: "layers", screenId: selectionStore.get().screenId })}
        fallback={(failure, retryPanel) => (
          <RegionError failure={failure} retry={retryPanel} fallbackTitle="The layers panel stopped working" />
        )}
      >
        <RenderFault region="layers" />
        {screenId ? (
          <LayersTree key={screenId} screenId={screenId} />
        ) : (
          <div className="panel-empty">Click something in a preview</div>
        )}
      </Region>
    </aside>
  );
}

const depthOf = (row: Row) => (row.kind === "message" || row.kind === "searchError" ? 0 : row.depth);

function LayersTree({ screenId }: { screenId: string }) {
  const tree = useStore(layersStore, (s) => s[screenId]) ?? EMPTY_TREE;
  const guard = useGuard();
  const selection = useStore(selectionStore);
  const hover = useStore(hoverStore);
  const rows = useMemo(() => visibleRows(tree), [tree]);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(() => savedScrollTop(screenId));
  const [viewHeight, setViewHeight] = useState(0);

  useEffect(() => ensureLoaded(screenId), [screenId]);

  useLayoutEffect(() => {
    const el = listRef.current!;
    el.scrollTop = savedScrollTop(screenId);
    setViewHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [screenId]);

  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => row.kind === "node" && map.set(row.id, i));
    return map;
  }, [rows]);
  const maxDepth = useMemo(() => {
    let max = 0;
    for (const row of rows) max = Math.max(max, depthOf(row));
    return max;
  }, [rows]);

  // Scroll the newly selected row into view, once per reveal.
  const revealed = useRef(0);
  useLayoutEffect(() => {
    const reveal = tree.reveal;
    if (!reveal || reveal.seq === revealed.current) return;
    const index = rowIndex.get(reveal.id);
    if (index === undefined) return;
    revealed.current = reveal.seq;
    const el = listRef.current!;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
    // Deep rows are indented past the panel edge; bring the name into view too.
    const left = 8 + depthOf(rows[index]) * INDENT;
    if (left < el.scrollLeft || left + NAME_MIN_WIDTH > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - 2 * INDENT);
    }
  }, [tree.reveal, rowIndex, rows]);

  const selectedIds = selection.screenId === screenId ? selection.ids : [];
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // A hovered element under a collapsed row lights up its nearest visible ancestor.
  let hoveredRow: string | null = null;
  if (hover?.screenId === screenId) {
    for (let i = hover.path.length - 1; i >= 0; i--) {
      if (rowIndex.has(hover.path[i])) {
        hoveredRow = hover.path[i];
        break;
      }
    }
  }

  const searching = tree.search !== null;
  const matches = tree.search?.results?.matches;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const cursor = selectedIds[selectedIds.length - 1];
    const index = cursor === undefined ? -1 : (rowIndex.get(cursor) ?? -1);
    const nodeAt = (i: number) => {
      const row = rows[i];
      return row?.kind === "node" ? row : null;
    };
    const step = (from: number, dir: 1 | -1) => {
      for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
        const row = nodeAt(i);
        if (row) return row.id;
      }
      return null;
    };

    if (index < 0) {
      const first = step(-1, 1);
      if (first) pickRow(screenId, first, false);
      return;
    }
    const row = nodeAt(index)!;
    const node = tree.nodes[row.id];
    let target: string | null = null;
    switch (event.key) {
      case "ArrowDown":
        target = step(index, 1);
        break;
      case "ArrowUp":
        target = step(index, -1);
        break;
      case "ArrowRight":
        if (!node?.hasChildren) break;
        if (!searching && !tree.expanded[row.id]) {
          setExpanded(screenId, row.id, true);
          break;
        }
        target = nodeAt(index + 1)?.parent === row.id ? nodeAt(index + 1)!.id : null;
        break;
      case "ArrowLeft":
        if (!searching && node?.hasChildren && tree.expanded[row.id]) {
          setExpanded(screenId, row.id, false);
          break;
        }
        target = row.parent === ROOT ? null : row.parent;
        break;
    }
    if (target) pickRow(screenId, target, false);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);

  return (
    <>
      <div className="layers-search">
        <input
          type="search"
          placeholder="Search layers"
          aria-label="Search layers"
          value={tree.search?.query ?? ""}
          onChange={guard((e: React.ChangeEvent<HTMLInputElement>) => setSearch(screenId, e.target.value))}
          onKeyDown={guard((e: React.KeyboardEvent) => {
            if (e.key === "Escape" && tree.search) {
              e.preventDefault();
              e.stopPropagation();
              setSearch(screenId, "");
            }
          })}
        />
        {tree.search?.results?.truncated && (
          <div className="layers-search-note">Showing the first results only</div>
        )}
      </div>
      <div
        ref={listRef}
        className="layers-list"
        role="tree"
        aria-label="Layers"
        aria-multiselectable
        tabIndex={0}
        onKeyDown={guard(onKeyDown)}
        onScroll={guard((e: React.UIEvent<HTMLDivElement>) => {
          const top = e.currentTarget.scrollTop;
          setScrollTop(top);
          saveScrollTop(screenId, top);
        })}
        onMouseLeave={guard(() => hoverRow(screenId, null))}
      >
        <div
          className="layers-spacer"
          style={{ height: rows.length * ROW_HEIGHT, minWidth: 8 + maxDepth * INDENT + 16 + NAME_MIN_WIDTH }}
        >
          {rows.slice(first, last).map((row, i) => (
            <RowView
              key={row.kind === "node" ? row.id : "key" in row ? `${row.kind}:${row.key}` : row.kind}
              row={row}
              top={(first + i) * ROW_HEIGHT}
              screenId={screenId}
              name={row.kind === "node" ? (tree.nodes[row.id]?.name ?? "") : ""}
              hasChildren={row.kind === "node" && Boolean(tree.nodes[row.id]?.hasChildren)}
              expanded={row.kind === "node" && (searching || Boolean(tree.expanded[row.id]))}
              searching={searching}
              selected={row.kind === "node" && selectedSet.has(row.id)}
              hovered={row.kind === "node" && hoveredRow === row.id}
              match={row.kind === "node" && Boolean(matches?.[row.id])}
            />
          ))}
        </div>
      </div>
    </>
  );
}

type RowProps = {
  row: Row;
  top: number;
  screenId: string;
  name: string;
  hasChildren: boolean;
  expanded: boolean;
  searching: boolean;
  selected: boolean;
  hovered: boolean;
  match: boolean;
};

const RowView = memo(function RowView(props: RowProps) {
  const { row, top, screenId } = props;
  const guard = useGuard();
  const style = { top, height: ROW_HEIGHT };

  if (row.kind === "message") {
    return (
      <div className="layers-row layers-row--muted" style={{ ...style, paddingLeft: 12 }}>
        {row.text}
      </div>
    );
  }
  if (row.kind === "searchError") {
    return (
      <div className="layers-row layers-row--error" style={{ ...style, paddingLeft: 12 }}>
        Search failed
        <button type="button" className="layers-retry" onClick={guard(() => retrySearch(screenId))}>
          Retry
        </button>
      </div>
    );
  }

  const paddingLeft = 8 + row.depth * INDENT + 16;
  if (row.kind === "loading") {
    return (
      <div
        className="layers-row layers-row--muted"
        style={{ ...style, paddingLeft }}
        onMouseEnter={guard(() => hoverRow(screenId, null))}
      >
        Loading…
      </div>
    );
  }
  if (row.kind === "error") {
    return (
      <div
        className="layers-row layers-row--error"
        style={{ ...style, paddingLeft }}
        onMouseEnter={guard(() => hoverRow(screenId, null))}
      >
        Couldn't load
        <button type="button" className="layers-retry" onClick={guard(() => retry(screenId, row.key))}>
          Retry
        </button>
      </div>
    );
  }

  const id = row.id;
  const classes = ["layers-row"];
  if (props.selected) classes.push("is-selected");
  if (props.hovered) classes.push("is-hovered");
  if (props.match) classes.push("is-match");

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={props.hasChildren ? props.expanded : undefined}
      aria-selected={props.selected}
      className={classes.join(" ")}
      style={{ ...style, paddingLeft: 8 + row.depth * INDENT }}
      onMouseEnter={guard(() => hoverRow(screenId, id))}
      onClick={guard((e: React.MouseEvent) => {
        if (takeFault("layersClick")) throw new Error("Dev: error in a layers row click handler");
        pickRow(screenId, id, e.shiftKey);
      })}
    >
      {props.hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          className={`layers-chevron${props.expanded ? " is-open" : ""}`}
          aria-label={props.expanded ? "Collapse" : "Expand"}
          disabled={props.searching}
          onClick={guard((e: React.MouseEvent) => {
            e.stopPropagation();
            toggleExpanded(screenId, id);
          })}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
            <path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      ) : (
        <span className="layers-chevron-spacer" />
      )}
      <span className="layers-name">{props.name}</span>
    </div>
  );
});
