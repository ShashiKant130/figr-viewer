import { useStore } from "../lib/store";
import { selectionStore } from "../overlay/selectionStore";
import { liveStore, type LiveProps } from "./liveStore";
import { useElementDetails } from "./useElementDetails";

type Field = {
  label: string;
  value: (p: LiveProps) => string;
  color?: boolean;
};

const FIELDS: Field[] = [
  { label: "Name", value: (p) => p.name },
  { label: "Tag", value: (p) => p.tag },
  { label: "ID", value: (p) => p.elementId || "—" },
  { label: "Classes", value: (p) => p.classes.join(" ") || "—" },
  { label: "Size", value: (p) => `${p.width} × ${p.height}` },
  { label: "Position", value: (p) => `${p.x}, ${p.y}` },
  { label: "Text", value: (p) => p.text || "—" },
  { label: "Text colour", value: (p) => p.color, color: true },
  { label: "Background", value: (p) => p.background, color: true },
  { label: "Font", value: (p) => p.fontFamily },
  { label: "Font size", value: (p) => p.fontSize },
  { label: "Font weight", value: (p) => p.fontWeight },
];

const MIXED = "Mixed";

export function Inspector() {
  const selection = useStore(selectionStore);
  const live = useStore(liveStore);
  const pageLive = selection.screenId ? live[selection.screenId] : undefined;

  let body: React.ReactNode;
  if (selection.ids.length === 1) {
    const id = selection.ids[0];
    body = <SingleElement key={id} props={pageLive?.[id]} screenId={selection.screenId} />;
  } else if (selection.ids.length > 1) {
    body = <SeveralElements props={selection.ids.map((id) => pageLive?.[id])} />;
  } else if (selection.lost) {
    body = <div className="panel-empty">This element no longer exists</div>;
  } else {
    body = <div className="panel-empty">Nothing selected</div>;
  }

  return (
    <aside className="panel panel--inspector">
      <div className="panel-header">Inspector</div>
      <div className="inspector-body">{body}</div>
    </aside>
  );
}

function SingleElement({ props, screenId }: { props: LiveProps | undefined; screenId: string | null }) {
  return (
    <>
      <section className="inspector-section">
        <h3 className="inspector-heading">Live</h3>
        {props ? (
          <dl className="inspector-fields">
            {FIELDS.map((field) => (
              <FieldRow key={field.label} field={field} value={field.value(props)} />
            ))}
          </dl>
        ) : (
          <div className="inspector-note">Reading…</div>
        )}
      </section>
      <section className="inspector-section">
        <h3 className="inspector-heading">Details</h3>
        {props ? <Details elementKey={props.key} screenId={screenId} /> : <div className="inspector-note">Reading…</div>}
      </section>
    </>
  );
}

function SeveralElements({ props }: { props: (LiveProps | undefined)[] }) {
  const ready = props.every((p): p is LiveProps => p !== undefined);
  return (
    <section className="inspector-section">
      <h3 className="inspector-heading">{props.length} elements</h3>
      {ready ? (
        <dl className="inspector-fields">
          {FIELDS.map((field) => {
            const first = field.value(props[0]);
            const shared = props.every((p) => field.value(p) === first);
            return <FieldRow key={field.label} field={field} value={shared ? first : MIXED} />;
          })}
        </dl>
      ) : (
        <div className="inspector-note">Reading…</div>
      )}
    </section>
  );
}

function FieldRow({ field, value }: { field: Field; value: string }) {
  const mixed = value === MIXED;
  return (
    <>
      <dt>{field.label}</dt>
      <dd className={mixed ? "is-mixed" : undefined}>
        {field.color && !mixed && <span className="inspector-swatch" style={{ background: value }} />}
        {value}
      </dd>
    </>
  );
}

function Details({ elementKey, screenId }: { elementKey: string | null; screenId: string | null }) {
  const { state, retry } = useElementDetails(elementKey, screenId);

  if (state === null) return <div className="inspector-note">No details</div>;
  switch (state.status) {
    case "loading":
      return <div className="inspector-note">Loading…</div>;
    case "missing":
      return <div className="inspector-note">No details for this element</div>;
    case "error":
      return (
        <div className="inspector-error">
          <span>Couldn't load details</span>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      );
    case "ready": {
      const { component, description, status, owner } = state.details;
      return (
        <dl className="inspector-fields">
          <dt>Component</dt>
          <dd>{component}</dd>
          <dt>Description</dt>
          <dd>{description}</dd>
          <dt>Status</dt>
          <dd>{status}</dd>
          <dt>Owner</dt>
          <dd>{owner}</dd>
        </dl>
      );
    }
  }
}
