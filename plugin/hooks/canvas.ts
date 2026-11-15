// The workflow canvas: the same build as the work graph, drawn as who
// directs whom. The orchestrator on top, the subagents and pipeline runs it
// started under it, and under those what they use: the blueprint's pieces
// (MCP servers, documents) and the tools a loop reaches for (the web, another
// MCP server, a skill). A dashed line joins two that have to do with each
// other; while one is calling the other the line takes a colour and packets
// run along it, from the caller to the called.
//
// No drawing here either: `canvas` lays the picture out in cells for the
// room there is and hands back lines like the work graph's. `paint` in
// `model.ts` moves the packets.
import type { Act, Agent, Live } from "../types";
import type { Line, Seg, Tone } from "./model";
import { cells, fit, moving, oneLine } from "./model";

type Lang = "ko" | "en";

const WORDS = {
  ko: {
    main: "오케스트레이터",
    web: "웹",
    more: (n: number) => `+${n}`,
    parts: (up: number, all: number) => `부품 ${up}/${all} 조립됨`,
    servers: (n: number) => `실행 중 ${n}`,
    docs: (n: number) => `문서 ${n}`,
    flowing: "호출 중",
    idle: "아직 시작한 작업이 없어요",
  },
  en: {
    main: "Orchestrator",
    web: "Web",
    more: (n: number) => `+${n}`,
    parts: (up: number, all: number) => `pieces ${up}/${all} assembled`,
    servers: (n: number) => `${n} running`,
    docs: (n: number) => `${n} documents`,
    flowing: "calling",
    idle: "Nothing has started yet",
  },
};

const DOCUMENTS = ["skill", "rule", "instruction", "subagent"];
const HUES = 3;

// --- the two tabs

const TABS = {
  ko: { graph: ["작업 그래프", "그래프"], canvas: ["워크플로우 캔버스", "캔버스"] },
  en: { graph: ["Work graph", "Graph"], canvas: ["Workflow canvas", "Canvas"] },
};

/** What the two tab buttons say, for the room there is: `[ a ] [ b ]` has to fit. */
export function tabLabels(lang: Lang, columns: number): { graph: string; canvas: string } {
  const t = TABS[lang];
  const long = cells(t.graph[0] as string) + cells(t.canvas[0] as string) + 9;
  const i = columns >= long ? 0 : 1;
  return { graph: t.graph[i] as string, canvas: t.canvas[i] as string };
}

// --- what a loop reaches for

/** How many things reached for are remembered. */
const ACTS = 10;

/**
 * What a tool call reaches for, when that is something the canvas shows:
 * a piece of the build (a tool of a running piece, or `piece_call`), the
 * web, another MCP server, a skill. Null for the rest (files, the shell,
 * Encela's own tools): those are said on the caller's own node.
 */
export function actOf(
  tool: string,
  input: Record<string, unknown>,
  own: string | null,
  ownTools: ReadonlySet<string>,
): Pick<Act, "kind" | "name"> | null {
  const named = (kind: Act["kind"], name: string) => {
    const clean = fit(oneLine(name), 40);
    return clean ? { kind, name: clean } : null;
  };
  if (own !== null) {
    if (own === "piece_call") return named("piece", String(input.id ?? "").replace(/^[a-z]+:/, ""));
    if (ownTools.has(own)) return null;
    const at = own.indexOf("__");
    return at > 0 ? named("piece", own.slice(0, at)) : null;
  }
  if (tool === "WebSearch" || tool === "WebFetch") return { kind: "web", name: "web" };
  if (tool === "Skill") return named("skill", String(input.skill ?? ""));
  if (tool.startsWith("mcp__")) {
    return named("mcp", (tool.split("__")[1] ?? "").replace(/^plugin_[^_]+_/, ""));
  }
  return null;
}

/** `list` after `from` began (`by` 1) or ended (`by` -1) a call to `to`. */
export function acted(
  list: readonly Act[],
  from: string,
  to: Pick<Act, "kind" | "name">,
  by: 1 | -1,
): Act[] {
  const id = `${from}\u0001${to.kind}\u0001${to.name}`;
  const was = list.find((a) => a.id === id) ?? { id, from, ...to, busy: 0, calls: 0 };
  const now: Act = {
    ...was,
    busy: Math.max(0, was.busy + by),
    calls: was.calls + (by > 0 ? 1 : 0),
  };
  const kept = [...list.filter((a) => a.id !== id), now];
  while (kept.length > ACTS) {
    // What is in flight stays; of the rest the oldest goes.
    const drop = kept.findIndex((a) => a.busy === 0 && a.id !== id);
    if (drop < 0) break;
    kept.splice(drop, 1);
  }
  return kept;
}

/**
 * `list` once the turn of `from` is over: nothing of it is in flight any
 * more. After the main loop's turn, what was only reached for in passing
 * (the web, a skill, another server) leaves the canvas; pieces stay.
 */
export function settled(list: readonly Act[], from: string): Act[] {
  return list
    .map((a) => (a.from === from ? { ...a, busy: 0 } : a))
    .filter((a) => from !== "main" || a.kind === "piece" || a.busy > 0);
}

// --- the picture

interface Node {
  id: string;
  layer: number;
  glyph: string;
  label: string;
  /** A second line where there is room: what it is doing. */
  sub: string;
  tone: Tone;
  hue?: number;
  /** Its marker turns while work is going on. */
  spin: boolean;
  /** Drawn with a dashed border: a piece that is named but not assembled yet. */
  loose: boolean;
  x: number;
  y: number;
  w: number;
}

interface Edge {
  from: string;
  to: string;
  /** 0: they have to do with each other. 1: one has called the other. 2: it is calling it now. */
  rank: 0 | 1 | 2;
  hue?: number;
}

interface Px {
  ch: string;
  tone: Tone;
  hue?: number;
  fx?: "spin" | "flow";
  at?: number;
  /** The second cell of a wide character: nothing is drawn for it. */
  skip?: true;
  /** For a cell of a line: which neighbours it joins, and how strongly. */
  link?: number;
  rank?: number;
}

const N = 1;
const E = 2;
const S = 4;
const W = 8;
const LINK: Record<number, string> = {
  [N]: "┆",
  [S]: "┆",
  [N | S]: "┆",
  [E]: "┄",
  [W]: "┄",
  [E | W]: "┄",
  [S | E]: "╭",
  [S | W]: "╮",
  [N | E]: "╰",
  [N | W]: "╯",
  [N | E | W]: "┴",
  [S | E | W]: "┬",
  [N | S | E]: "├",
  [N | S | W]: "┤",
  [N | S | E | W]: "┼",
};

/** How a picture is drawn for the rows there are: node height, and rows between two layers. */
const MODES = [
  { node: 4, gap: 3 },
  { node: 3, gap: 2 },
  { node: 3, gap: 1 },
  { node: 1, gap: 1 },
] as const;

export interface CanvasOptions {
  rows: number;
  columns: number;
  lang?: Lang;
}

/**
 * The canvas for a state, as lines for `rows` and `columns`. What doesn't
 * fit a layer's width is gathered into one `+n` node; with too few rows the
 * nodes lose their second line, then their boxes.
 */
export function canvas(
  live: Live | null,
  agents: readonly Agent[],
  acts: readonly Act[],
  opts: CanvasOptions,
): Line[] {
  const lang: Lang = live?.lang ?? opts.lang ?? "en";
  const w = WORDS[lang];
  const columns = Math.max(16, Math.floor(opts.columns));
  const rows = Math.max(3, Math.floor(opts.rows));
  const b = live?.blueprint ?? null;
  const hueOf = (worker: string) => {
    const i = b?.workers.indexOf(worker) ?? -1;
    return i < 0 ? undefined : i % HUES;
  };
  const tint = <T extends object>(o: T, hue: number | undefined): T =>
    hue === undefined ? o : { ...o, hue };
  const active = agents.filter((a) => !a.done);
  const working = active.some((a) => a.doing !== "") || moving(live);

  // --- who and what there is
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const node = (n: Omit<Node, "x" | "y" | "w">) => {
    nodes.push({ ...n, label: oneLine(n.label), sub: oneLine(n.sub), x: 0, y: 0, w: 0 });
  };
  const main = agents.find((a) => a.id === "main");
  const mainBusy = !!main && main.doing !== "";
  node({
    id: "main",
    layer: 0,
    glyph: "◆",
    label: w.main,
    sub: main?.doing ?? "",
    tone: mainBusy ? "busy" : "strong",
    spin: false,
    loose: false,
  });
  const subs = agents.filter((a) => a.id !== "main");
  // Those at work first: they are the ones kept when the row is too narrow.
  for (const a of [...subs.filter((x) => !x.done), ...subs.filter((x) => x.done)]) {
    const hue = hueOf(a.worker);
    const at = !a.done && a.doing !== "";
    node(
      tint(
        {
          id: `agent:${a.id}`,
          layer: 1,
          glyph: a.done ? "✓" : "●",
          label: a.worker || a.about || a.id,
          sub: a.done ? "" : a.doing,
          tone: (a.done ? "good" : at ? "busy" : "plain") as Tone,
          spin: at,
          loose: false,
        },
        hue,
      ),
    );
    edges.push(tint({ from: "main", to: `agent:${a.id}`, rank: (at ? 2 : 0) as 0 | 2 }, hue));
  }
  const runs = (live?.runs ?? []).filter((r) => r.status === "running" || r.status === "waiting");
  for (const r of runs) {
    const over = r.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
    const going = r.status === "running";
    node({
      id: `run:${r.id}`,
      layer: 1,
      glyph: "≋",
      label: r.pipeline,
      sub: `${over}/${r.steps.length}`,
      tone: going ? "busy" : "wait",
      spin: false,
      loose: false,
    });
    edges.push({ from: "main", to: `run:${r.id}`, rank: going ? 2 : 0 });
  }
  const assembled = !!live && ["assemble", "build", "done"].includes(live.phase);
  const pieces = live?.pieces ?? [];
  const order = (p: (typeof pieces)[number]) =>
    p.busy > 0 ? 0 : p.running ? 1 : DOCUMENTS.includes(p.kind) ? 3 : 2;
  for (const p of [...pieces].sort((x, y) => order(x) - order(y))) {
    const doc = DOCUMENTS.includes(p.kind);
    node({
      id: `piece:${p.name}`,
      layer: 2,
      glyph: doc ? "▤" : p.running ? "●" : "○",
      label: p.name,
      sub: doc ? p.kind : p.last ? `${p.last} · ${p.calls}` : p.kind,
      tone: p.busy > 0 ? "busy" : doc ? (assembled ? "plain" : "dim") : p.running ? "good" : "dim",
      spin: p.busy > 0,
      loose: !assembled,
    });
    // Being put together: the orchestrator reaches for every piece.
    if (live?.phase === "assemble") edges.push({ from: "main", to: `piece:${p.name}`, rank: 2 });
    // A pipeline calls pieces by itself.
    if (p.busy > 0) {
      for (const r of runs.filter((x) => x.status === "running")) {
        edges.push({ from: `run:${r.id}`, to: `piece:${p.name}`, rank: 2 });
      }
    }
  }
  for (const a of acts) {
    const from = a.from === "main" ? "main" : `agent:${a.from}`;
    if (!nodes.some((n) => n.id === from)) continue;
    let to = `piece:${a.name}`;
    if (a.kind !== "piece" || !nodes.some((n) => n.id === to)) {
      to = `${a.kind}:${a.name}`;
      if (!nodes.some((n) => n.id === to)) {
        node({
          id: to,
          layer: 2,
          glyph: a.kind === "web" ? "◎" : a.kind === "skill" ? "▤" : "○",
          label: a.kind === "web" ? w.web : a.name,
          sub: a.kind,
          tone: a.busy > 0 ? "busy" : "dim",
          spin: a.busy > 0,
          loose: false,
        });
      } else if (a.busy > 0) {
        const there = nodes.find((n) => n.id === to) as Node;
        there.tone = "busy";
        there.spin = true;
      }
    }
    const sub = agents.find((x) => x.id === a.from);
    edges.push(
      tint({ from, to, rank: (a.busy > 0 ? 2 : 1) as 1 | 2 }, sub ? hueOf(sub.worker) : undefined),
    );
  }

  // --- the layers, top to bottom: an empty one takes no room
  const used = [0, 1, 2].filter((l) => nodes.some((n) => n.layer === l));
  for (const n of nodes) n.layer = used.indexOf(n.layer);
  const layers = used.length;
  const foot = pieces.length > 0 && rows >= layers * 2 + 2 ? 1 : 0;
  const mode =
    MODES.find((m) => columns >= 28 && layers * m.node + (layers - 1) * m.gap <= rows - foot) ??
    (MODES[MODES.length - 1] as (typeof MODES)[number]);
  const boxed = mode.node > 1;
  // A line from the top layer to the bottom one goes round the middle one, down the left edge.
  const round = (e: Edge) => {
    const a = nodes.find((n) => n.id === e.from);
    const z = nodes.find((n) => n.id === e.to);
    return !!a && !!z && z.layer - a.layer > 1;
  };
  const lane = edges.some(round) ? 2 : 0;
  const room = columns - lane;

  // --- each layer fitted to the width: narrower nodes first, then fewer
  const least = boxed ? 8 : 5;
  const most = boxed ? 26 : 22;
  const between = boxed ? 1 : 2;
  const gone = new Map<string, string>();
  for (let l = 0; l < layers; l++) {
    let row = nodes.filter((n) => n.layer === l);
    const fits = Math.max(1, Math.floor((room + between) / (least + between)));
    if (row.length > fits) {
      const kept = row.slice(0, Math.max(1, fits - 1));
      const rest = row.slice(kept.length);
      const plus: Node = {
        id: `more:${l}`,
        layer: l,
        glyph: "…",
        label: w.more(rest.length),
        sub: "",
        tone: rest.some((n) => n.tone === "busy") ? "busy" : "dim",
        spin: false,
        loose: false,
        x: 0,
        y: 0,
        w: 0,
      };
      for (const n of rest) {
        gone.set(n.id, plus.id);
        nodes.splice(nodes.indexOf(n), 1);
      }
      nodes.push(plus);
      row = [...kept, plus];
    }
    // A box: two borders, the marker, a space each side of the name.
    const want = (n: Node) => {
      const text = Math.max(cells(n.label), mode.node > 3 ? Math.min(18, cells(n.sub)) : 0);
      return Math.max(least, Math.min(most, text + (boxed ? 5 : 2)));
    };
    const widths = row.map(want);
    const total = () => widths.reduce((a, c) => a + c, 0) + between * (row.length - 1);
    // Too wide together: the widest give way first.
    while (total() > room) {
      const widest = Math.max(...widths);
      if (widest <= least) break;
      widths[widths.indexOf(widest)] = widest - 1;
    }
    let x = lane + Math.max(0, Math.floor((room - total()) / 2));
    row.forEach((n, i) => {
      n.w = Math.min(widths[i] as number, Math.max(1, columns - x));
      n.x = x;
      n.y = l * (mode.node + mode.gap);
      x += n.w + between;
    });
  }
  // Lines to and from what was gathered go to the `+n` node; of two between the same pair the stronger stays.
  const joined = new Map<string, Edge>();
  for (const e of edges) {
    const from = gone.get(e.from) ?? e.from;
    const to = gone.get(e.to) ?? e.to;
    if (from === to) continue;
    const key = `${from}\u0001${to}`;
    const was = joined.get(key);
    if (!was || e.rank > was.rank) joined.set(key, { ...e, from, to });
  }

  // --- drawing into cells
  const height = Math.min(rows - foot, layers * mode.node + (layers - 1) * mode.gap);
  const grid: (Px | undefined)[][] = Array.from({ length: Math.max(1, height) }, () =>
    new Array<Px | undefined>(columns).fill(undefined),
  );
  const set = (x: number, y: number, px: Px) => {
    const line = grid[y];
    if (line && x >= 0 && x < columns) line[x] = px;
  };
  const put = (x: number, y: number, text: string, px: Omit<Px, "ch">) => {
    let at = x;
    for (const ch of text) {
      const wide = cells(ch) > 1;
      if (at + (wide ? 1 : 0) >= columns) break;
      set(at, y, { ...px, ch });
      if (wide) set(at + 1, y, { ch: "", tone: px.tone, skip: true });
      at += wide ? 2 : 1;
    }
  };
  const portOf = (n: Node) => (boxed ? n.x + Math.floor(n.w / 2) : n.x);
  for (const n of nodes) {
    const marker: Omit<Px, "ch"> = tint(
      { tone: n.tone, ...(n.spin && working ? { fx: "spin" as const } : {}) },
      n.hue,
    );
    const name: Omit<Px, "ch"> = tint({ tone: n.tone === "dim" ? "dim" : "plain" }, n.hue);
    if (!boxed) {
      put(n.x, n.y, n.glyph, marker);
      put(n.x + 2, n.y, fit(n.label, Math.max(1, n.w - 2)), name);
      continue;
    }
    const edge: Omit<Px, "ch"> = tint(
      { tone: n.tone === "busy" ? "busy" : "dim" },
      n.tone === "busy" ? n.hue : undefined,
    );
    const bar = n.loose ? "┄" : "─";
    const side = n.loose ? "┆" : "│";
    const last = n.y + mode.node - 1;
    put(n.x, n.y, `╭${bar.repeat(Math.max(0, n.w - 2))}╮`, edge);
    put(n.x, last, `╰${bar.repeat(Math.max(0, n.w - 2))}╯`, edge);
    for (let y = n.y + 1; y < last; y++) {
      set(n.x, y, { ...edge, ch: side });
      set(n.x + n.w - 1, y, { ...edge, ch: side });
    }
    const inside = Math.max(1, n.w - 4);
    put(n.x + 1, n.y + 1, n.glyph, marker);
    put(n.x + 3, n.y + 1, fit(n.label, inside), name);
    if (mode.node > 3 && n.sub) put(n.x + 3, n.y + 2, fit(n.sub, inside), { tone: "dim" });
  }

  // A line is a walk from cell to cell; where walks meet, the cell joins them all.
  const walk = (cellsOf: [number, number][], e: Edge, open: number, close: number) => {
    cellsOf.forEach(([x, y], i) => {
      const prev = cellsOf[i - 1];
      const next = cellsOf[i + 1];
      let link = 0;
      const toward = (o: [number, number] | undefined, fallback: number) => {
        if (!o) return fallback;
        if (o[0] > x) return E;
        if (o[0] < x) return W;
        return o[1] > y ? S : N;
      };
      link |= toward(prev, open);
      link |= toward(next, close);
      const line = grid[y];
      if (!line || x < 0 || x >= columns) return;
      const was = line[x];
      // A line never draws over a node.
      if (was && was.link === undefined) return;
      const all = (was?.link ?? 0) | link;
      const rank = was?.rank ?? -1;
      const mine: Px =
        e.rank >= rank
          ? tint(
              {
                ch: "",
                tone: (e.rank === 2 ? "busy" : e.rank === 1 ? "plain" : "dim") as Tone,
                rank: e.rank,
                ...(e.rank === 2 && working ? { fx: "flow" as const, at: i } : {}),
              },
              e.rank === 2 ? e.hue : undefined,
            )
          : (was as Px);
      line[x] = { ...mine, link: all, ch: LINK[all] ?? "┼" };
    });
  };
  // The walks of each gap are spread over its rows by where they start, so two callers' lines lie apart.
  const starts = new Map<string, number>();
  const rowIn = (gapTop: number, from: Node) => {
    const key = `${gapTop}\u0001${from.id}`;
    if (!starts.has(key)) {
      const taken = [...starts.keys()].filter((k) => k.startsWith(`${gapTop}\u0001`)).length;
      starts.set(key, taken % mode.gap);
    }
    return gapTop + (starts.get(key) as number);
  };
  const weakFirst = [...joined.values()].sort((x, y) => x.rank - y.rank);
  for (const e of weakFirst) {
    const a = nodes.find((n) => n.id === e.from);
    const z = nodes.find((n) => n.id === e.to);
    if (!a || !z || z.layer <= a.layer) continue;
    const xs = portOf(a);
    const xt = portOf(z);
    const top = a.y + mode.node;
    const bottom = z.y - 1;
    const path: [number, number][] = [];
    const down = (x: number, from: number, to: number) => {
      for (let y = from; y <= to; y++) path.push([x, y]);
    };
    const across = (y: number, from: number, to: number) => {
      const step = to > from ? 1 : -1;
      for (let x = from + step; x !== to + step; x += step) path.push([x, y]);
    };
    if (z.layer - a.layer === 1) {
      const turn = rowIn(top, a);
      down(xs, top, turn);
      if (xt !== xs) across(turn, xs, xt);
      if (bottom > turn) down(xt, turn + 1, bottom);
    } else {
      const first = rowIn(top, a);
      const lastGap = z.y - mode.gap;
      const second = rowIn(lastGap, a);
      down(xs, top, first);
      across(first, xs, 0);
      down(0, first + 1, second);
      if (xt !== 0) across(second, 0, xt);
      if (bottom > second) down(xt, second + 1, bottom);
    }
    walk(path, e, N, S);
    if (boxed) {
      // Where a line leaves and enters a box, the border shows it.
      const out = grid[a.y + mode.node - 1]?.[xs];
      if (out) out.ch = "┬";
      const into = grid[z.y]?.[xt];
      if (into) into.ch = "┴";
    }
  }

  // --- cells to lines
  const lines: Line[] = grid.map((line, y) => {
    const left: Seg[] = [];
    let end = line.length;
    while (end > 0 && line[end - 1] === undefined) end--;
    for (let x = 0; x < end; x++) {
      const px = line[x];
      if (px?.skip) continue;
      const s: Seg = px
        ? {
            text: px.ch,
            tone: px.tone,
            ...(px.hue === undefined ? {} : { hue: px.hue }),
            ...(px.fx ? { fx: px.fx } : {}),
            ...(px.fx === "flow" ? { at: px.at ?? 0 } : {}),
          }
        : { text: " ", tone: "plain" };
      const before = left[left.length - 1];
      // Cells drawn alike are one run; a cell that moves stays by itself.
      if (before && !s.fx && !before.fx && before.tone === s.tone && before.hue === s.hue) {
        before.text += s.text;
      } else left.push(s);
    }
    return { left, key: `canvas:${y}` };
  });
  if (nodes.length === 1 && !mainBusy && !live?.blueprint) {
    lines.push({ left: [{ text: fit(w.idle, columns), tone: "dim" }] });
  }
  if (foot) {
    const up = assembled ? pieces.length : 0;
    const servers = pieces.filter((p) => p.running).length;
    const docs = pieces.filter((p) => DOCUMENTS.includes(p.kind)).length;
    const calling = [...joined.values()].filter((e) => e.rank === 2).length;
    const said: Seg[] = [
      { text: w.parts(up, pieces.length), tone: assembled ? "good" : "dim" },
      ...(servers ? [{ text: ` · ● ${w.servers(servers)}`, tone: "dim" as Tone }] : []),
      ...(docs ? [{ text: ` · ▤ ${w.docs(docs)}`, tone: "dim" as Tone }] : []),
      ...(calling && working
        ? [{ text: ` · ■ ${w.flowing} ${calling}`, tone: "busy" as Tone }]
        : []),
    ];
    let left = columns;
    const cut: Seg[] = [];
    for (const s of said) {
      if (left <= 0) break;
      const text = fit(s.text, left);
      cut.push({ ...s, text });
      left -= cells(text);
    }
    lines.push({ left: cut });
  }
  return lines.slice(0, rows);
}
