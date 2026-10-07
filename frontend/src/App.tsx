import { Board } from "./board/Board";
import { Toolbar } from "./Toolbar";

export function App() {
  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <aside className="panel panel--layers">
          <div className="panel-header">Layers</div>
          <div className="panel-empty">Click something in a preview</div>
        </aside>
        <Board />
        <aside className="panel panel--inspector">
          <div className="panel-header">Inspector</div>
          <div className="panel-empty">Nothing selected</div>
        </aside>
      </div>
    </div>
  );
}
