import { Board } from "./board/Board";
import { Region, RegionError } from "./failures/Region";
import { Inspector } from "./inspector/Inspector";
import { LayersPanel } from "./layers/LayersPanel";
import { Toolbar } from "./Toolbar";

export function App() {
  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <LayersPanel />
        <Region
          id="board"
          context={() => ({ region: "board", screenId: null })}
          fallback={(failure, retry) => (
            <div className="board">
              <RegionError
                className="board-message board-message--error"
                failure={failure}
                retry={retry}
                fallbackTitle="The board stopped working"
              />
            </div>
          )}
        >
          <Board />
        </Region>
        <Inspector />
      </div>
    </div>
  );
}
