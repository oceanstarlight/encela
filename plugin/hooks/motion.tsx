// The view's lines, moving. A surface module: where the surface can redraw a
// region by itself (the terminal, the desktop app) Claude Code runs this on
// its drawing thread, so a spinner turns and a pulse beats without a hook
// running or anything crossing to the engine.
//
// It draws what `view.tsx` hands it and decides nothing: which marker
// spins, what pulses and what was just changed is all in the lines
// (`fx`, `key`, `sig`), and `meet`, `tickOn` and `paint` in `model.ts` say
// how a line looks at each tick. One clock runs for the instance's life and
// asks for a redraw only while something moves.
import type { ClientModule } from "claude-code";
import type { Cell, Line, Motion } from "./model";
import { look, meet, paint, TICK, tickOn } from "./model";

interface Shown {
  lines: Line[];
  columns: number;
}

const Lines: ClientModule = (given, surface) => {
  const { lines, columns } = given as unknown as Shown;
  const { Box, Text } = surface.elements;
  const kept = surface.state as Motion | undefined;
  const motion = meet(kept, lines);
  if (motion !== kept) surface.setState(motion);
  if (kept === undefined) {
    surface.every(TICK, () => {
      const now = surface.state as Motion | undefined;
      if (now?.live) surface.setState(tickOn(now));
    });
  }
  const run = (cells: Cell[]) => cells.map((c) => <Text {...look(c)}>{c.text}</Text>);
  return (
    <Box flexDirection="column" width="100%">
      {lines.map((line) => {
        const { left, right } = paint(line, motion, columns);
        if (!left.length && !right.length) return <Text> </Text>;
        return (
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              {" ".repeat(line.indent ?? 0)}
              {run(left)}
            </Text>
            {right.length > 0 && <Text>{run(right)}</Text>}
          </Box>
        );
      })}
    </Box>
  );
};

export default Lines;
