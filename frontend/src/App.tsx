import { Board } from "./board/Board";
import { Inspector } from "./inspector/Inspector";
import { LayersPanel } from "./layers/LayersPanel";
import { Toolbar } from "./Toolbar";

export function App() {
  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <LayersPanel />
        <Board />
        <Inspector />
      </div>
    </div>
  );
}
