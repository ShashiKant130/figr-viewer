import { useStore } from "../lib/store";
import { selectionStore } from "../overlay/selectionStore";

export function Inspector() {
  const selection = useStore(selectionStore);

  let body: React.ReactNode;
  if (selection.ids.length > 0) {
    body = (
      <ul className="inspector-list">
        {selection.ids.map((id) => (
          <li key={id}>{selection.elements[id].name}</li>
        ))}
      </ul>
    );
  } else if (selection.lost) {
    body = <div className="panel-empty">This element no longer exists</div>;
  } else {
    body = <div className="panel-empty">Nothing selected</div>;
  }

  return (
    <aside className="panel panel--inspector">
      <div className="panel-header">Inspector</div>
      {body}
    </aside>
  );
}
