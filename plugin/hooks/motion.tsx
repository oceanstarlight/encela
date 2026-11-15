// The view's lines, moving. A surface module: where the surface can redraw a
// region by itself (the terminal, the desktop app) Claude Code runs this on
// its drawing thread, so a spinner turns, a pulse beats and packets run
// along the canvas's lines without a hook running or anything crossing to
// the engine.
//
// It draws what `view.tsx` hands it and decides nothing about a build: which
// marker spins, what pulses, where packets run and what was just changed is
// all in the lines (`fx`, `at`, `key`, `sig`), and `meet`, `tickOn` and
// `paint` in `model.ts` say how a line looks at each tick. One clock runs
// for the instance's life and asks for a redraw only while something moves.
//
// The pane comes with two pictures of the build and a tab for each. Which
// one shows is kept here, so a press changes it at once; the hooks module is
// told, and remembers it for the session.
import type { ClientModule } from "claude-code";
import type { Tab } from "../types";
import type { Cell, Line, Motion } from "./model";
import { look, meet, paint, TICK, tickOn } from "./model";

interface Shown {
  lines: Line[];
  columns: number;
  /** The pane only: the canvas's lines, the tab the session last chose, and what the tabs say. */
  canvas?: Line[];
  tab?: Tab;
  labels?: { graph: string; canvas: string };
}

interface Kept {
  motion: Motion;
  tab: Tab;
  /** The tab the hooks module last named: when it names another, that one shows. */
  told: Tab;
  /** Whether there are tabs at all: the small form has one picture and none to choose. */
  tabs: boolean;
}

const Lines: ClientModule = (given, surface) => {
  const { lines, columns, canvas, labels, tab: named } = given as unknown as Shown;
  const { Box, Text, Button } = surface.elements;
  const kept = surface.state as Kept | undefined;
  const told: Tab = named ?? "graph";
  const tab: Tab = !canvas ? "graph" : kept && kept.told === told ? kept.tab : told;
  const showing = tab === "canvas" && canvas ? canvas : lines;
  const motion = meet(kept?.motion, showing);
  const tabs = !!canvas;
  if (
    !kept ||
    motion !== kept.motion ||
    kept.tab !== tab ||
    kept.told !== told ||
    kept.tabs !== tabs
  ) {
    surface.setState({ motion, tab, told, tabs } satisfies Kept);
  }
  const choose = (to: Tab) => {
    const now = surface.state as Kept | undefined;
    if (!now?.tabs || now.tab === to) return;
    surface.setState({ ...now, tab: to } satisfies Kept);
    surface.post({ tab: to });
  };
  if (kept === undefined) {
    surface.every(TICK, () => {
      const now = surface.state as Kept | undefined;
      if (now?.motion.live) surface.setState({ ...now, motion: tickOn(now.motion) });
    });
    // With the focus on the pane, Tab and the arrows go from one picture to the other.
    surface.onKey((event) => {
      if (!["tab", "left", "right"].includes(event.key)) return;
      const now = surface.state as Kept | undefined;
      if (now) choose(now.tab === "graph" ? "canvas" : "graph");
    });
  }
  const run = (cells: Cell[]) => cells.map((c) => <Text {...look(c)}>{c.text}</Text>);
  return (
    <Box flexDirection="column" width="100%">
      {canvas && labels && (
        <Box>
          <Button
            key="tab-graph"
            label={labels.graph}
            hotkey="1"
            variant={tab === "graph" ? "primary" : "secondary"}
            onPress={() => choose("graph")}
          />
          <Text> </Text>
          <Button
            key="tab-canvas"
            label={labels.canvas}
            hotkey="2"
            variant={tab === "canvas" ? "primary" : "secondary"}
            onPress={() => choose("canvas")}
          />
        </Box>
      )}
      {showing.map((line) => {
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
